import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import AABBDevice from './aabb_device'
import { currentRecord } from './monitoring_record'
import {
    CONTROL_PAUSE,
    CONTROL_POWER_OFF,
    CourseSelection,
    codeOf,
    courseControl,
    shortControl,
} from './monitoring_command'

// LG heat-pump dryer sold in Korea - matched on modelId "RH14_N_KR", nameplate "Hisen Refresh 27inch
// 14kg", deviceType 202. AABB frames start with 0x30 and carry a 25-byte monitoring record (see
// monitoring_record.ts); 0x72 heartbeats are not decoded.
//
// The offsets below came from the appliance's own cloud, not from static analysis: with the dryer
// bridged, a fromDevice frame whose payload byte i held the value i was injected, and the cloud replied
// with its decoded washerDryer state naming each field beside the value it had been handed
// (state=0, remainTimeHour=1, ... downloadedCourse=23). A second frame carrying i+100 gave every field
// a value no enum defines, so each came back as "NOT_DEFINE_VALUE value:1xx" and confirmed its byte a
// second time. The option bits were pinned by a nine-round sweep that encodes (byte, bit) as a binary
// word, and the course table by stepping rec[5] through every code and reading back the name.
// Everything was cross-checked against a real drying cycle: 02 00 18 01 23 07 00 03 02 02 ... decodes
// as Running, 24 min left of a 1h35m Cotton Normal at Iron dry level on Eco Hybrid Normal, matching the
// cloud's snapshot of this unit field for field.
const DEV_BYTE = 0x30
const PAYLOAD_LEN = 25

const STATE_OFFSET = 0
const REMAIN_HOUR_OFFSET = 1
const REMAIN_MIN_OFFSET = 2
const INITIAL_HOUR_OFFSET = 3
const INITIAL_MIN_OFFSET = 4
const COURSE_OFFSET = 5
const ERROR_OFFSET = 6
const DRY_LEVEL_OFFSET = 7
const ECO_HYBRID_OFFSET = 8
// rec[9] is the step within the cycle, which the state byte alone does not distinguish: everything from
// the first moisture sensing to the anti-crease tumble at the end reports state RUNNING.
const PROCESS_OFFSET = 9
const RESERVE_HOUR_OFFSET = 12
const RESERVE_MIN_OFFSET = 13
// rec[14], rec[15] and rec[16]: three option bitfields.
const FLAGS_OFFSET = 14
const FLAG_RESERVATION = 0x01
const FLAG_ANTI_CREASE = 0x02
const FLAG_CHILD_LOCK = 0x10
const FLAG_SELF_CLEAN = 0x20
const FLAG_DAMP_DRY_BEEP = 0x40
const FLAG_HAND_IRON = 0x80
const OPT2_OFFSET = 15
const OPT2_REMOTE_START = 0x01 // 0x20 dnnReady, 0x40 standby: not user-facing settings
// Not worth an entity of its own, but it is what separates starting a cycle from resuming a paused one
// in a command.
const OPT2_INITIAL_BIT = 0x02
const OPT3_OFFSET = 16
const OPT3_STEAM = 0x08 // 0x04 smartPairing (the washer-to-dryer course handover), left undecoded
// rec[17:19]: energy used by the running cycle, big-endian, in Wh. The cloud does not decode it for
// this model, but the styler in the same protocol family publishes exactly these two bytes as
// energyMonitoring, and the counter here climbs at ~12 Wh/min during a cycle - a heat pump's ~0.7 kW.
const ENERGY_OFFSET = 17

const STATE_OFF = 0
const STATE_PAUSED = 3

const STATE: Record<number, string> = {
    0: 'Off',
    1: 'Initial',
    2: 'Running',
    3: 'Paused',
    4: 'Complete',
    5: 'Error',
    8: 'Audible diagnosis',
    100: 'Reserved',
}

const PROCESS: Record<number, string> = {
    0: 'Sensing',
    1: 'Steam',
    2: 'Drying (level 1)',
    3: 'Drying (level 2)',
    4: 'Drying (level 3)',
    5: 'Cooling',
    6: 'Anti-crease',
    7: 'End',
}

// Course codes, each named by the cloud during the sweep. Codes past this unit's own dial are kept so a
// sibling model on the same family table reports something better than "unknown".
const COURSE: Record<number, string> = {
    0: 'None',
    1: 'Refresh',
    2: 'Towels',
    3: 'Jeans',
    4: 'Bulky Items',
    5: 'Easy Care',
    6: 'Mixed Fabrics',
    7: 'Cotton Normal',
    8: 'Sportswear',
    9: 'Quick Dry',
    10: 'Delicates',
    11: 'Wool',
    12: 'Rack Dry',
    13: 'Cool Air',
    14: 'Warm Air',
    15: 'Bedding Brush',
    16: 'Allergy Care',
    17: 'Power',
    18: 'Condenser Care',
    19: 'Tub Clean',
    20: 'Padding Refresh',
    21: 'Time Dry',
    22: 'Water Repellent',
    23: 'Baby Wear',
    24: 'Small Load',
    25: 'Cotton+',
    26: 'Perm Press',
    27: 'Pet Care',
}

const DRY_LEVEL: Record<number, string> = {
    0: 'None',
    1: 'Damp Dry',
    2: 'Less Dry',
    3: 'Iron Dry',
    4: 'Cupboard Dry',
    5: 'Very Dry',
}

const ECO_HYBRID: Record<number, string> = {
    0: 'None',
    1: 'Eco',
    2: 'Normal',
    3: 'Turbo',
}

/*
 * What each course runs with: [dry level, Eco Hybrid]. A start command carries the settings as well as
 * the course, and these are the defaults the dryer's own panel would fill in, read from the model
 * JSON. Only the courses this unit's dial has are listed - the wider COURSE table above exists so a
 * sibling model reports a name, not so this one can start a cycle it has no program for.
 *
 * Confirmed on the wire for Cotton Normal: the app's start frame was 07 03 02 ... , and the record the
 * dryer sent back a second later reported exactly that - course 7, Iron Dry, Eco Hybrid Normal.
 */
const PRESET: Record<number, [number, number]> = {
    2: [0, 2], // Towels
    4: [0, 3], // Bulky Items
    5: [3, 2], // Easy Care
    7: [3, 2], // Cotton Normal
    8: [0, 1], // Sportswear
    9: [0, 3], // Quick Dry
    11: [0, 2], // Wool
    12: [0, 1], // Rack Dry
    13: [0, 0], // Cool Air
    14: [0, 2], // Warm Air
    15: [0, 3], // Bedding Brush
    16: [0, 3], // Allergy Care
    17: [0, 2], // Power
    18: [0, 3], // Condenser Care
    19: [0, 3], // Tub Clean
    20: [0, 3], // Padding Refresh
    21: [0, 0], // Time Dry
}

// The start command's own layout, 14 bytes: the settings first, in the order the model JSON lists
// them, then the option byte carrying rec[15]'s bits. The dryer's other option bits - anti-crease,
// child lock, the damp-dry beep - are somewhere in the five bytes between, which stayed zero in the
// one start this dryer was recorded being given; nothing here needs them.
const CMD_LEN = 14
const CMD_COURSE = 0
const CMD_DRY_LEVEL = 1
const CMD_ECO_HYBRID = 2
const CMD_OPT2 = 10 // rec[15]'s bits

// Resuming is the same frame with the initial bit cleared, as on the washer and the mini washer of
// this family; unlike theirs, this one has not been seen on the wire.
export function startPayload(course: number, resume: boolean): Buffer | undefined {
    const preset = PRESET[course]
    if (!preset) return undefined

    const [dryLevel, ecoHybrid] = preset
    const payload = Buffer.alloc(CMD_LEN)
    payload[CMD_COURSE] = course
    payload[CMD_DRY_LEVEL] = dryLevel
    payload[CMD_ECO_HYBRID] = ecoHybrid
    payload[CMD_OPT2] = OPT2_REMOTE_START | (resume ? 0 : OPT2_INITIAL_BIT)
    return payload
}

// What a Home Assistant select can offer: the courses this handler knows how to start.
const SELECTABLE = Object.keys(PRESET).map((code) => COURSE[Number(code)])

const ERROR: Record<number, string> = {
    0: 'OK',
    1: 'Temperature sensor error (TE1)',
    2: 'Temperature sensor error (TE2)',
    7: 'Communication error (CE1)',
    13: 'Drain pump error',
    14: 'Water tank empty',
    15: 'Door error',
    17: 'Filter missing',
    19: 'Unknown error (F1)',
    20: 'Locked motor error (LE2)',
    21: 'Water supply error (AE)',
    30: 'Locked motor error (LE1)',
    37: 'Door sensor error (DE4)',
    39: 'Locked motor error (LE3)',
    42: 'Door lock error (DE2)',
}

export default class Device extends AABBDevice {
    private readonly course = new CourseSelection()
    private state = STATE_OFF

    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq)
        this.setConfig(
            allowExtendedType({
                ...HADevice.config(meta, { name: 'LG Dryer' }),
                components: {
                    power: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-power',
                        state_topic: '$this/power',
                        name: 'Power',
                        icon: 'mdi:tumble-dryer',
                        device_class: 'running',
                    },
                    status: {
                        platform: 'sensor',
                        unique_id: '$deviceid-status',
                        state_topic: '$this/status',
                        name: 'Status',
                        icon: 'mdi:state-machine',
                        // free-text (NOT device_class:enum): an unmapped state code emits 'Running'.
                    },
                    process: {
                        platform: 'sensor',
                        unique_id: '$deviceid-process',
                        state_topic: '$this/process',
                        name: 'Cycle step',
                        icon: 'mdi:progress-clock',
                    },
                    course: {
                        platform: 'sensor',
                        unique_id: '$deviceid-course',
                        state_topic: '$this/course',
                        name: 'Course',
                        icon: 'mdi:pin-outline',
                    },
                    // Two entities for one idea, because the appliance keeps them apart: "Course" above
                    // is where the dial sits, this is what Start will ask for. They agree until one is
                    // changed here, and turning the dial brings them back together.
                    course_select: {
                        platform: 'select',
                        unique_id: '$deviceid-course_select',
                        state_topic: '$this/course_select',
                        command_topic: '$this/course_select/set',
                        name: 'Course selection',
                        icon: 'mdi:playlist-check',
                        options: SELECTABLE,
                    },
                    start: {
                        platform: 'button',
                        unique_id: '$deviceid-start',
                        command_topic: '$this/start/set',
                        payload_press: '',
                        name: 'Start',
                        icon: 'mdi:play-circle-outline',
                    },
                    pause: {
                        platform: 'button',
                        unique_id: '$deviceid-pause',
                        command_topic: '$this/pause/set',
                        payload_press: '',
                        name: 'Pause',
                        icon: 'mdi:pause-circle-outline',
                    },
                    power_off: {
                        platform: 'button',
                        unique_id: '$deviceid-power_off',
                        command_topic: '$this/power_off/set',
                        payload_press: '',
                        name: 'Power off',
                        icon: 'mdi:power',
                    },
                    remaining_time: {
                        platform: 'sensor',
                        unique_id: '$deviceid-remaining_time',
                        state_topic: '$this/remaining_time',
                        name: 'Remaining time',
                        icon: 'mdi:timer-outline',
                        device_class: 'duration',
                        unit_of_measurement: 'min',
                        // The dryer re-estimates this from the moisture sensor as it goes, so it can
                        // step back up mid-cycle; that is the appliance's own figure, not a decode slip.
                    },
                    initial_time: {
                        platform: 'sensor',
                        unique_id: '$deviceid-initial_time',
                        state_topic: '$this/initial_time',
                        name: 'Cycle length',
                        icon: 'mdi:clock-outline',
                        device_class: 'duration',
                        unit_of_measurement: 'min',
                        entity_category: 'diagnostic',
                    },
                    reserve_time: {
                        platform: 'sensor',
                        unique_id: '$deviceid-reserve_time',
                        state_topic: '$this/reserve_time',
                        name: 'Reserved finish time',
                        icon: 'mdi:clock-plus-outline',
                        device_class: 'duration',
                        unit_of_measurement: 'min',
                    },
                    dry_level: {
                        platform: 'sensor',
                        unique_id: '$deviceid-dry_level',
                        state_topic: '$this/dry_level',
                        name: 'Dry level',
                        icon: 'mdi:water-percent',
                    },
                    eco_hybrid: {
                        platform: 'sensor',
                        unique_id: '$deviceid-eco_hybrid',
                        state_topic: '$this/eco_hybrid',
                        name: 'Eco Hybrid',
                        icon: 'mdi:leaf',
                    },
                    energy: {
                        platform: 'sensor',
                        unique_id: '$deviceid-energy',
                        state_topic: '$this/energy',
                        name: 'Cycle energy',
                        device_class: 'energy',
                        unit_of_measurement: 'Wh',
                        state_class: 'measurement', // per cycle, not a lifetime total
                    },
                    error: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-error',
                        state_topic: '$this/error',
                        name: 'Error',
                        icon: 'mdi:check-circle',
                        device_class: 'problem',
                        entity_category: 'diagnostic',
                    },
                    error_message: {
                        platform: 'sensor',
                        unique_id: '$deviceid-error-message',
                        state_topic: '$this/error_message',
                        name: 'Error message',
                        icon: 'mdi:alert-circle-outline',
                        entity_category: 'diagnostic',
                    },
                    steam: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-steam',
                        state_topic: '$this/steam',
                        name: 'Steam',
                        icon: 'mdi:kettle-steam',
                    },
                    anti_crease: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-anti_crease',
                        state_topic: '$this/anti_crease',
                        name: 'Anti-crease',
                        icon: 'mdi:tshirt-crew-outline',
                    },
                    hand_iron: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-hand_iron',
                        state_topic: '$this/hand_iron',
                        name: 'Easy iron',
                        icon: 'mdi:iron-outline',
                    },
                    damp_dry_beep: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-damp_dry_beep',
                        state_topic: '$this/damp_dry_beep',
                        name: 'Damp dry beep',
                        icon: 'mdi:water-alert-outline',
                    },
                    self_clean: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-self_clean',
                        state_topic: '$this/self_clean',
                        name: 'Condenser self-clean',
                        icon: 'mdi:air-filter',
                    },
                    reservation: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-reservation',
                        state_topic: '$this/reservation',
                        name: 'Reservation',
                        icon: 'mdi:clock-plus-outline',
                    },
                    child_lock: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-child_lock',
                        state_topic: '$this/child_lock',
                        name: 'Child lock',
                        icon: 'mdi:lock',
                        entity_category: 'diagnostic',
                    },
                    remote_start: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-remote_start',
                        state_topic: '$this/remote_start',
                        name: 'Remote start',
                        icon: 'mdi:cellphone-wireless',
                        entity_category: 'diagnostic',
                    },
                },
            }),
        )
    }

    processAABB(buf: Buffer) {
        const rec = currentRecord(buf, DEV_BYTE, PAYLOAD_LEN)
        if (!rec) return

        const state = rec[STATE_OFFSET]
        const isOff = state === STATE_OFF
        this.state = state

        this.course.follow(rec[COURSE_OFFSET])
        if (this.course.selected) this.publishProperty('course_select', COURSE[this.course.selected])

        this.publishProperty('power', isOff ? 'OFF' : 'ON')
        this.publishProperty('status', STATE[state] ?? 'Running')
        this.publishProperty('process', isOff ? 'None' : (PROCESS[rec[PROCESS_OFFSET]] ?? 'unknown'))
        this.publishProperty('course', COURSE[rec[COURSE_OFFSET]] ?? 'unknown')

        // Zeroed while off: the appliance keeps the last cycle's figures in these bytes, which would
        // otherwise read in Home Assistant as a countdown frozen mid-cycle.
        this.publishProperty('remaining_time', isOff ? 0 : rec[REMAIN_HOUR_OFFSET] * 60 + rec[REMAIN_MIN_OFFSET])
        this.publishProperty('initial_time', isOff ? 0 : rec[INITIAL_HOUR_OFFSET] * 60 + rec[INITIAL_MIN_OFFSET])
        this.publishProperty('reserve_time', isOff ? 0 : rec[RESERVE_HOUR_OFFSET] * 60 + rec[RESERVE_MIN_OFFSET])

        this.publishProperty('dry_level', DRY_LEVEL[rec[DRY_LEVEL_OFFSET]] ?? 'unknown')
        this.publishProperty('eco_hybrid', ECO_HYBRID[rec[ECO_HYBRID_OFFSET]] ?? 'unknown')
        this.publishProperty('energy', rec.readUInt16BE(ENERGY_OFFSET))

        const error = rec[ERROR_OFFSET]
        this.publishProperty('error', error !== 0 ? 'ON' : 'OFF')
        this.publishProperty('error_message', ERROR[error] ?? `Unknown error (${error})`)

        const flags = rec[FLAGS_OFFSET]
        this.publishProperty('reservation', flags & FLAG_RESERVATION ? 'ON' : 'OFF')
        this.publishProperty('anti_crease', flags & FLAG_ANTI_CREASE ? 'ON' : 'OFF')
        this.publishProperty('child_lock', flags & FLAG_CHILD_LOCK ? 'ON' : 'OFF')
        this.publishProperty('self_clean', flags & FLAG_SELF_CLEAN ? 'ON' : 'OFF')
        this.publishProperty('damp_dry_beep', flags & FLAG_DAMP_DRY_BEEP ? 'ON' : 'OFF')
        this.publishProperty('hand_iron', flags & FLAG_HAND_IRON ? 'ON' : 'OFF')

        this.publishProperty('remote_start', rec[OPT2_OFFSET] & OPT2_REMOTE_START ? 'ON' : 'OFF')
        this.publishProperty('steam', rec[OPT3_OFFSET] & OPT3_STEAM ? 'ON' : 'OFF')
        // Decoded by the cloud but not published: the smart-course and downloaded-course slots (rec[20],
        // rec[23]). Nothing names rec[10], rec[11], rec[19], rec[21], rec[22] or rec[24], and two bits
        // of rec[15] (0x08, 0x10) come up while a cycle runs with no cloud field following them.
    }

    // The dryer only obeys any of this with Remote Start armed on its own panel, which is a deliberate
    // piece of LG's design and not something a command can switch on. The remote_start sensor above
    // says whether it is armed.
    setProperty(prop: string, mqttValue: string) {
        if (prop === 'course_select') {
            const code = codeOf(COURSE, mqttValue)
            if (code === undefined || !(code in PRESET)) return
            this.course.select(code)
            this.publishProperty('course_select', mqttValue)
        }

        if (prop === 'start') {
            const payload = startPayload(this.course.selected, this.state === STATE_PAUSED)
            if (payload) this.send(courseControl(payload))
        }

        if (prop === 'pause') this.send(shortControl(CONTROL_PAUSE))
        if (prop === 'power_off') this.send(shortControl(CONTROL_POWER_OFF))
    }
}
