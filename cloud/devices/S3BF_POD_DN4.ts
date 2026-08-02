import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import AABBDevice from './aabb_device'
import { currentRecord } from './monitoring_record'

// LG Styler (steam clothing care cabinet) sold in Korea - matched on modelId "S3BF_POD_DN4", nameplate
// "Essence_ESL", deviceType 203. AABB frames start with 0x31 and carry a 28-byte monitoring record
// (see monitoring_record.ts); 0x72 heartbeats are not decoded.
//
// The byte offsets below were read out of the appliance's own cloud, not guessed: a fromDevice frame
// whose payload byte i simply held the value i was injected while bridged, and the cloud answered with
// its decoded styler.* state, naming every field next to the value it had been given - state=0,
// remainTimeHour=1, ... currentDownloadCourse4=27. The boolean options were pinned the same way with a
// nine-round sweep that encodes (byte, bit) as a binary word, so each flag's byte and mask are exact
// rather than inferred from which options happened to be on. The state and error bytes then needed a
// sweep of their own, code by code through 0..127, because the model JSON spells those two enums out as
// label dicts carrying no index at all - see the note above STATE.
//
// Everything was then re-checked against real traffic: the idle record 00 01 35 01 35 ... 20 00 00 02
// cb ... decodes to state=POWEROFF, 1h53m remaining/estimated and energy=715 Wh, matching the cloud's
// own snapshot of this unit field for field, and a real Indoor Dry 240 min run came out as
// Initial -> Drying -> Error(door closed) -> Paused -> Drying -> Off, which is exactly what the
// appliance did.
const DEV_BYTE = 0x31
const PAYLOAD_LEN = 28

const STATE_OFFSET = 0
const REMAIN_HOUR_OFFSET = 1
const REMAIN_MIN_OFFSET = 2
const INITIAL_HOUR_OFFSET = 3
const INITIAL_MIN_OFFSET = 4
const COURSE_OFFSET = 5
const ERROR_OFFSET = 6
// rec[7] is the state the appliance was in before the current one (the cloud calls it preState) - it is
// decoded by the cloud but adds nothing to Home Assistant, which keeps its own history.
const RESERVE_HOUR_OFFSET = 12
const RESERVE_MIN_OFFSET = 13
// rec[14]: options bitfield. Bit 5 is set on every record this unit has ever sent, including with the
// appliance off, and no cloud field follows it - left alone rather than exposed as an invented toggle.
const FLAGS_OFFSET = 14
const FLAG_CHILD_LOCK = 0x01
const FLAG_NIGHT_DRY = 0x02
const FLAG_REMOTE_START = 0x08 // 0x04 is the cloud's initialBit, protocol bookkeeping, not a setting
// rec[17:19]: energy used by the running cycle, big-endian, in Wh (the cloud publishes it as
// energyMonitoring). It holds the last cycle's total while the appliance is idle.
const ENERGY_OFFSET = 17
const SMART_COURSE_OFFSET = 20
// rec[23] counts the download-course slots in use; rec[24:28] are the slots themselves. Only the first
// is published - this model has maxDownloadCourseNum 1, so the rest are always empty.
const DOWNLOAD_COURSE_OFFSET = 24

const STATE_OFF = 0

// State codes, every one of them named by stepping rec[0] through 0..127 and reading the cloud's
// decode back. The model JSON's Value.State is a name->label dict with no index, and its key order is
// NOT the wire code: it lists PRESTEAM..FOTA as entries 10-19, while the appliance really sends 50-59
// and 98. Codes 50-59 are the steps of a running cycle - a real Indoor Dry run reported 55.
const STATE: Record<number, string> = {
    0: 'Off',
    1: 'Initial',
    2: 'Running',
    3: 'Paused',
    4: 'Complete',
    5: 'Error',
    6: 'Diagnosis',
    7: 'Night Dry',
    8: 'Reserved',
    9: 'Sleep',
    50: 'Pre-steam',
    51: 'Pre-heat',
    52: 'Steam',
    53: 'Stay',
    54: 'Cooling',
    55: 'Drying',
    56: 'End cooling',
    57: 'Sterilizing',
    58: 'Finishing',
    59: 'Complete (keeping clothes fresh)',
    98: 'Firmware update',
}

// Error codes, swept the same way and for the same reason - the model JSON's Error dict order only
// happens to match the wire up to 9. Code 31 is the one a user meets by accident: the courses that dry
// into the room refuse to start with the door shut.
const ERROR: Record<number, string> = {
    0: 'OK',
    1: 'Temperature sensor error (TE1)',
    2: 'Temperature sensor error (TE2)',
    3: 'Temperature sensor error (TE3)',
    4: 'Temperature sensor error (TE4)',
    5: 'Temperature sensor error (TE5)',
    6: 'System error (E1)',
    7: 'System error (E2)',
    8: 'System error (E3)',
    9: 'System error (E4)',
    10: 'Motor error (LE2)',
    11: 'Water supply error (AE)',
    18: 'Motor error (LE)',
    25: 'Water drain error',
    26: 'Door open error',
    31: 'Door closed - this course needs the door open',
    32: 'System error (E6)',
    33: 'Power supply error (PS)',
    34: 'Unknown error (IF)',
}

// Course codes come from the model JSON's own ConvertingRule (code -> name), which for this family is
// authoritative - the same table the cloud decoded our injected course=5 with, returning STRONG.
const COURSE: Record<number, string> = {
    0: 'None',
    1: 'Standard',
    3: 'Quick',
    5: 'Heavy',
    6: 'Wool / Knitwear',
    7: 'Suits / Coats',
    8: 'Sportswear',
    9: 'Download course',
    10: 'Functional wear',
    11: 'Sanitary Standard',
    12: 'Bedding',
    13: 'Kids',
    14: 'Dolls',
    15: 'Drying (Normal)',
    16: 'Drying (Wool / Knitwear)',
    17: 'Time Dry 30 min',
    18: 'Time Dry 60 min',
    19: 'Time Dry 90 min',
    20: 'Time Dry 120 min',
    21: 'Time Dry 150 min',
    22: 'Rain / Snow',
    23: 'Indoor Dry 120 min', // TIME_DRY_INSIDE_120 - dries the room, hence the door-open requirement
    24: 'Indoor Dry 240 min',
    25: 'Night Care',
    26: 'Sanitary Professional',
    27: 'Uniform Care',
    28: 'Padding Care',
    29: 'Trouser Crease Care',
    30: 'Fine Dust',
    31: 'Virus Care',
    32: 'Jeans',
    33: 'Fur / Leather',
    34: 'Static Removal',
    35: "Kids' items",
    67: 'Silent (downloaded)',
    78: 'Fur / Leather (downloaded)',
}

// Smart (downloadable) course codes, likewise from the model JSON's ConvertingRule.
const SMART_COURSE: Record<number, string> = {
    0: 'None',
    61: 'Suits / Uniforms',
    62: 'Scarves',
    63: 'Athletic wear',
    64: 'Smoke removal',
    65: 'Food odour removal',
    66: 'Trousers',
    67: 'Silent',
    68: 'Coat warmer',
    69: 'Static removal',
    70: 'Uniform care',
    71: 'Stored items',
    72: 'Allergy care',
    73: 'Blanket warmer',
    74: 'Uniform drying',
    75: 'Dress shirts',
    76: 'Rain / snow drying',
    77: 'Spot drying',
    78: 'Fur / Leather',
    90: 'Swimwear drying',
    91: 'Fine dust removal',
    92: 'Virus care',
    93: 'Jeans care',
    94: 'Baby clothes sanitary',
    95: 'Doll sanitary',
    96: 'Wool / delicate drying',
    97: 'Rainy days',
    98: 'Uniform',
    99: 'Padding care',
    100: 'Thin padding care',
    101: 'Thick padding care',
    102: 'Silk care',
}

export default class Device extends AABBDevice {
    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq)
        this.setConfig(
            allowExtendedType({
                ...HADevice.config(meta, { name: 'LG Styler' }),
                components: {
                    power: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-power',
                        state_topic: '$this/power',
                        name: 'Power',
                        icon: 'mdi:hanger',
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
                    course: {
                        platform: 'sensor',
                        unique_id: '$deviceid-course',
                        state_topic: '$this/course',
                        name: 'Course',
                        icon: 'mdi:pin-outline',
                    },
                    smart_course: {
                        platform: 'sensor',
                        unique_id: '$deviceid-smart_course',
                        state_topic: '$this/smart_course',
                        name: 'Smart course',
                        icon: 'mdi:cellphone-cog',
                    },
                    download_course: {
                        platform: 'sensor',
                        unique_id: '$deviceid-download_course',
                        state_topic: '$this/download_course',
                        name: 'Downloaded course',
                        icon: 'mdi:download-outline',
                        entity_category: 'diagnostic',
                    },
                    remaining_time: {
                        platform: 'sensor',
                        unique_id: '$deviceid-remaining_time',
                        state_topic: '$this/remaining_time',
                        name: 'Remaining time',
                        icon: 'mdi:timer-outline',
                        device_class: 'duration',
                        unit_of_measurement: 'min',
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
                    night_dry: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-night_dry',
                        state_topic: '$this/night_dry',
                        name: 'Night Dry',
                        icon: 'mdi:weather-night',
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

        this.publishProperty('power', isOff ? 'OFF' : 'ON')
        this.publishProperty('status', STATE[state] ?? 'Running')
        this.publishProperty('course', COURSE[rec[COURSE_OFFSET]] ?? 'unknown')
        this.publishProperty('smart_course', SMART_COURSE[rec[SMART_COURSE_OFFSET]] ?? 'unknown')
        this.publishProperty('download_course', SMART_COURSE[rec[DOWNLOAD_COURSE_OFFSET]] ?? 'unknown')

        // While the appliance is off these bytes keep whatever the last cycle left behind, which would
        // read in Home Assistant as a countdown that never moves.
        this.publishProperty('remaining_time', isOff ? 0 : rec[REMAIN_HOUR_OFFSET] * 60 + rec[REMAIN_MIN_OFFSET])
        this.publishProperty('initial_time', isOff ? 0 : rec[INITIAL_HOUR_OFFSET] * 60 + rec[INITIAL_MIN_OFFSET])
        this.publishProperty('reserve_time', isOff ? 0 : rec[RESERVE_HOUR_OFFSET] * 60 + rec[RESERVE_MIN_OFFSET])
        this.publishProperty('energy', rec.readUInt16BE(ENERGY_OFFSET))

        const error = rec[ERROR_OFFSET]
        this.publishProperty('error', error !== 0 ? 'ON' : 'OFF')
        this.publishProperty('error_message', ERROR[error] ?? `Unknown error (${error})`)

        const flags = rec[FLAGS_OFFSET]
        this.publishProperty('child_lock', flags & FLAG_CHILD_LOCK ? 'ON' : 'OFF')
        this.publishProperty('night_dry', flags & FLAG_NIGHT_DRY ? 'ON' : 'OFF')
        this.publishProperty('remote_start', flags & FLAG_REMOTE_START ? 'ON' : 'OFF')
        // Not published, because nothing in the cloud's decode names them: rec[8:12], rec[15], rec[16],
        // rec[19], rec[21], rec[22]. The settings the ThinQ app shows but the cloud does not decode from
        // this record either (buzzer, end melody, internal lighting, night-care start time, smart-care
        // toggles, tub-clean count) must ride in one of the frame types this model has not been seen
        // sending yet.
    }
}
