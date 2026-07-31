import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection, type ComponentInfo } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import AABBDevice from './aabb_device'

/**
 * LG dishwasher (식기세척기), ThinQ model D140110, deviceType 204.
 *
 * AABB like the cooktop, but the body starts with 0x32 rather than 0x42, discriminated by buf[1]:
 *   0xEC  status - two stacked 26-byte records, the previous state followed by the current one,
 *         exactly the shape the cooktop and the fridges use. Emitted on any change and once a minute
 *         while a cycle runs.
 *   0xB2  one record on its own, seen when the appliance settles into a new state (at the start of a
 *         capture, and again as a finished cycle dropped to standby). Carries nothing 0xEC does not.
 *   0x31  two 11-character ASCII part numbers with a few bytes each - "SAA41264002" and "SAA41261103"
 *         here. Board or firmware identity, sent alongside 0xB2. Not decoded.
 *   0xD8  three bytes, the last being the process code the appliance is about to report. Seen once,
 *         a second before the 0xEC that moved rinsing on to drying.
 *   0x72  five bytes, all zero after the header, twice as the end-of-cycle chime sounded.
 *   0xBF/0xCF  long frames (up to ~100 bytes) that restate the record and then carry a block of
 *         readings which look like temperatures and sensor counts. Emitted a few times per cycle.
 *         Not decoded - nothing here needs them, and nothing in them was confirmed.
 *
 * A record is <flags> 0x18 <24 bytes>, where 0x18 is the payload length. The payload is one byte per
 * entry of the model description's Monitoring.protocol list in that list's order, as far as the
 * scalars go; the run of booleans in the middle of that list is packed into bits instead, which is
 * why the payload is 24 bytes where the list has 32 entries.
 *
 * Everything published below was checked against the appliance during a full 1:33 Auto cycle, with
 * the real LG cloud's decoded snapshot read off its notification feed at the same time, so each
 * field is pinned by two independent readings of the same moment:
 *
 *   0     state          1 INITIAL -> 2 RUNNING -> 5 END -> 4 STANDBY -> 0 POWEROFF, each matching
 *                        the cloud, and the model's enum order throughout
 *   1     process        0 NONE -> 2 RUNNING -> 3 RINSING -> 4 DRYING -> 5 END, likewise
 *   2     error          0 the whole time; the names come from the model's error table order
 *   3,4   total time     1:33, which is the 93 minutes the cloud and the app both showed
 *   5     course         1 = Auto while running, reset to 0 as the cycle ended
 *   6     course type    0 = COURSE
 *   7,8   remaining      followed the countdown minute by minute. Not monotonic: an Auto cycle
 *                        re-reads the soil level and 1:27 became 0:51 in one step, which the cloud
 *                        reported the same way. It stops at 0:01 rather than reaching zero.
 *   9,10  reserve time   the delay-start clock, 0:00 throughout
 *   11    flags          bit 0 child lock - the panel was locked and unlocked and the cloud agreed
 *                        within the second; bit 1 door - set the moment the auto-open door swung
 *                        out; bit 4 the chime, the only other bit ever set and the cloud reported
 *                        the signal level on for the whole capture. Bits 2 and 3 are rinse and salt
 *                        refill by the same ordering, but this unit never asked for either.
 *   13,14 rinse aid, water softening levels - 2 and 0, as the cloud and the app both showed
 *
 * Not published, because nothing confirmed them: payload byte 12, which is where the option flags
 * (night dry, energy saver, high temp, extra dry and the rest) should sit but which read 0 for every
 * frame of a cycle that used none of them; byte 15, which sat at 9 even with the appliance switched
 * off, so it is not the smart course the ordering would suggest; bytes 16-22, always 0; and byte 23,
 * which read 1 while the cloud reported a downloaded Pots & Pans course - suggestive, but one
 * reading of one value is not a mapping.
 *
 * Read-only. The model does describe a control API, and the cloud reports the appliance as
 * controllableYn "N"; no command was sent to it and none was captured coming from the LG app, so
 * the encoding is unknown.
 */

const STATUS_FRAME_TYPE = 0xec
const RECORD_LENGTH = 26
const STATUS_FRAME_LENGTH = 2 + RECORD_LENGTH * 2
const CURRENT_RECORD_OFFSET = 2 + RECORD_LENGTH
// Inside a record: a flags byte, the payload length, then the payload itself.
const PAYLOAD_OFFSET = 2
const PAYLOAD_LENGTH = 0x18

const STATE = 0
const PROCESS = 1
const ERROR = 2
const TOTAL_HOUR = 3
const TOTAL_MIN = 4
const COURSE = 5
const REMAIN_HOUR = 7
const REMAIN_MIN = 8
const RESERVE_HOUR = 9
const RESERVE_MIN = 10
const FLAGS = 11
const RINSE_AID_LEVEL = 13
const SOFTENING_LEVEL = 14

// Bits of the flags byte, in the order the protocol list names them.
const FLAG_CHILD_LOCK = 0x01
const FLAG_DOOR_OPEN = 0x02
const FLAG_RINSE_REFILL = 0x04
const FLAG_SALT_REFILL = 0x08
const FLAG_CHIME = 0x10

// The model gives POWEROFF and STANDBY the same label, so the app cannot tell them apart. They are
// distinct states - a finished cycle passes through standby on its way to off - so both are kept.
const STATE_NAMES: Record<number, string> = {
    0: 'Off',
    1: 'Ready',
    2: 'Running',
    3: 'Paused',
    4: 'Standby',
    5: 'Finished',
    6: 'Power failed',
}

const PROCESS_NAMES: Record<number, string> = {
    0: 'None',
    1: 'Reserved',
    2: 'Washing',
    3: 'Rinsing',
    4: 'Drying',
    5: 'Finished',
    6: 'Night dry',
    7: 'Cancelled',
}

// The model's Course table, keyed by the id it carries on the wire.
const COURSE_NAMES: Record<number, string> = {
    0: 'None',
    1: 'Auto',
    2: 'Intensive',
    3: 'Delicate',
    4: 'Turbo',
    5: 'Eco',
    6: 'Rinse',
    7: 'Refresh',
    8: 'Express',
    9: 'Machine clean',
    11: 'Download cycle',
}

// The model's error table in its own order. Only ERROR_NO has ever been seen; the rest keep LG's
// two-letter codes, which are what the panel shows and what a search will match.
const ERROR_NAMES: Record<number, string> = {
    0: 'No error',
    1: 'HE',
    2: 'IE',
    3: 'OE',
    4: 'FE',
    5: 'TE',
    6: 'AE',
    7: 'EE',
    8: 'LE',
    9: 'NE',
    10: 'BE',
    11: 'F3',
}

const STATE_RUNNING = 2

function sensor(id: string, name: string, icon: string, extra?: object): ComponentInfo {
    return allowExtendedType({
        platform: 'sensor',
        unique_id: `$deviceid-${id}`,
        state_topic: `$this/${id}`,
        name,
        icon,
        ...extra,
    })
}

function binarySensor(id: string, name: string, icon: string, extra?: object): ComponentInfo {
    return allowExtendedType({
        platform: 'binary_sensor',
        unique_id: `$deviceid-${id}`,
        state_topic: `$this/${id}`,
        name,
        icon,
        ...extra,
    })
}

const DURATION = { device_class: 'duration', unit_of_measurement: 'min' }

export default class Device extends AABBDevice {
    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq)
        this.setConfig(
            allowExtendedType({
                ...HADevice.config(meta, { name: 'LG Dishwasher' }),
                components: {
                    // Free text rather than device_class:enum, so a code we have not seen shows up
                    // as unknown instead of being dropped.
                    status: sensor('status', 'Status', 'mdi:dishwasher'),
                    process: sensor('process', 'Cycle phase', 'mdi:water-sync'),
                    course: sensor('course', 'Cycle', 'mdi:playlist-check'),
                    error: sensor('error', 'Error', 'mdi:alert-circle-outline', {
                        entity_category: 'diagnostic',
                    }),

                    running: binarySensor('running', 'Running', 'mdi:dishwasher', {
                        device_class: 'running',
                    }),
                    door: binarySensor('door', 'Door', 'mdi:door-open', { device_class: 'door' }),
                    child_lock: binarySensor('child_lock', 'Child lock', 'mdi:lock'),
                    chime: binarySensor('chime', 'Chime', 'mdi:bell', { entity_category: 'diagnostic' }),
                    rinse_refill: binarySensor('rinse_refill', 'Rinse aid low', 'mdi:cup-water', {
                        device_class: 'problem',
                    }),
                    salt_refill: binarySensor('salt_refill', 'Salt low', 'mdi:shaker-outline', {
                        device_class: 'problem',
                    }),

                    total_time: sensor('total_time', 'Total time', 'mdi:timer-outline', DURATION),
                    remaining_time: sensor('remaining_time', 'Remaining time', 'mdi:timer-sand', DURATION),
                    reserve_time: sensor('reserve_time', 'Delayed start', 'mdi:timer-play-outline', DURATION),

                    rinse_aid_level: sensor('rinse_aid_level', 'Rinse aid level', 'mdi:cup-water', {
                        entity_category: 'diagnostic',
                    }),
                    softening_level: sensor('softening_level', 'Water softening level', 'mdi:water-percent', {
                        entity_category: 'diagnostic',
                    }),
                },
            }),
        )
    }

    processAABB(buf: Buffer) {
        if (buf.length !== STATUS_FRAME_LENGTH) return
        if (buf[0] !== 0x32 || buf[1] !== STATUS_FRAME_TYPE) return

        const record = buf.subarray(CURRENT_RECORD_OFFSET)
        // The record states its own payload length. Anything else is a frame we do not understand.
        if (record[1] !== PAYLOAD_LENGTH) return

        // The frame restates the previous record so a listener that missed one can still see what
        // changed. We only ever want where the appliance is now.
        this.processStatus(record.subarray(PAYLOAD_OFFSET))
    }

    private processStatus(p: Buffer) {
        const state = p[STATE]
        this.publishProperty('status', STATE_NAMES[state] ?? 'unknown')
        this.publishProperty('process', PROCESS_NAMES[p[PROCESS]] ?? 'unknown')
        this.publishProperty('course', COURSE_NAMES[p[COURSE]] ?? 'unknown')
        this.publishProperty('error', ERROR_NAMES[p[ERROR]] ?? 'unknown')
        this.publishProperty('running', state === STATE_RUNNING ? 'ON' : 'OFF')

        const flags = p[FLAGS]
        this.publishProperty('door', flags & FLAG_DOOR_OPEN ? 'ON' : 'OFF')
        this.publishProperty('child_lock', flags & FLAG_CHILD_LOCK ? 'ON' : 'OFF')
        this.publishProperty('chime', flags & FLAG_CHIME ? 'ON' : 'OFF')
        this.publishProperty('rinse_refill', flags & FLAG_RINSE_REFILL ? 'ON' : 'OFF')
        this.publishProperty('salt_refill', flags & FLAG_SALT_REFILL ? 'ON' : 'OFF')

        this.publishProperty('total_time', p[TOTAL_HOUR] * 60 + p[TOTAL_MIN])
        this.publishProperty('remaining_time', p[REMAIN_HOUR] * 60 + p[REMAIN_MIN])
        this.publishProperty('reserve_time', p[RESERVE_HOUR] * 60 + p[RESERVE_MIN])

        this.publishProperty('rinse_aid_level', p[RINSE_AID_LEVEL])
        this.publishProperty('softening_level', p[SOFTENING_LEVEL])
    }
}
