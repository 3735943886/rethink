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
    reportCommandAck,
    shortControl,
} from './monitoring_command'

// LG Styler (steam clothing care cabinet) sold in Korea - matched on modelId "S3BF_POD_DN4", nameplate
// "Essence_ESL", deviceType 203. AABB frames start with 0x31 and carry a 28-byte monitoring record
// (see monitoring_record.ts); 0x72 heartbeats are not decoded. The cabinet answers every command with
// a four-byte 0x00 frame, and reports two board serial numbers in ASCII behind 0x31. Its 0xB2 frames
// repeat the cycle time and the energy counter and then, in the longer variant, what looks like a
// history log in six-byte entries - left alone, since nothing names those fields.
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
const FLAG_REMOTE_START = 0x08
// The cloud's initialBit: bookkeeping in a record, but the difference between starting a course and
// resuming a paused one in a command.
const FLAG_INITIAL_BIT = 0x04
// rec[17:19]: energy used by the running cycle, big-endian, in Wh (the cloud publishes it as
// energyMonitoring). It holds the last cycle's total while the appliance is idle.
const ENERGY_OFFSET = 17
const SMART_COURSE_OFFSET = 20
// rec[23] counts the download-course slots in use; rec[24:28] are the slots themselves. Only the first
// is published - this model has maxDownloadCourseNum 1, so the rest are always empty.
const DOWNLOAD_COURSE_OFFSET = 24

const STATE_OFF = 0
const STATE_PAUSED = 3

/*
 * There is no way to switch this cabinet on from here, and the absence was measured rather than
 * assumed. A newer styler of the same protocol family takes a power-on as `f0 24 01 01 01`, a remote
 * control switch as `f0 24 10 01 01`, and its buzzer, end melody and night-care times as `f0 24 13`
 * sub-commands. All four were sent to this appliance. It answered every one of them with a plain
 * acknowledgement and then did nothing, which is exactly what it does with a control type of 0x7f -
 * and its model JSON agrees, listing only downloadCourse, offPower, startCourse, resumeCourse,
 * pauseCourse and wakeup, where wakeup carries no value and wakes the Wi-Fi module rather than the
 * cabinet.
 */

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

/*
 * Starting a course on this appliance is not a matter of naming it. Unlike the washers of the same
 * family, whose start command carries a course code and a handful of settings, the styler is handed
 * the entire recipe: twelve phases - pre-steam, pre-heat, steam, stay, cooling and drying, twice over -
 * each with a duration, a moisture-heater RPM and a fan RPM. The cabinet runs what it is told, and the
 * course code beside it is a label.
 *
 * These are those recipes, the 36 parameter bytes per course, from the model JSON's own per-course
 * defaults. The layout is not a guess: the one start the ThinQ app was recorded making - Fine Dust,
 * code 30 - rebuilds from this table byte for byte, all 46 of them, which pins the phase order, the
 * triplet structure and the two odd corners of the frame (the 0x80 on the first duration and the unused
 * trailing byte) at once.
 *
 * Only courses the model marks controlEnable are here; the dial's other programs (the timed indoor
 * dries, night care) are ones the app will not start remotely either.
 */
const RECIPE: Record<number, string> = {
    1: '02000000000006000003b40001b4001bb400000000000000000000000000000000000000', // Standard
    3: '02000000000003000000000001b4000eb400000000000000000000000000000000000000', // Quick
    5: '02006900000006006905c86903c8002bb400000000000000000000000000000000000000', // Heavy
    6: '020000000000040000000000010000147800000000000000000000000000000000000000', // Wool / Knitwear
    7: '02000000000005000002b40001b40018b400000000000000000000000000000000000000', // Suits / Coats
    8: '020000000000030000000000000000140000000000000000040000030000017800157800', // Sportswear
    11: '0200002300000500000a00000300001c7800000000000000000000000000000000000000', // Sanitary Standard
    12: '0200002300000500000a0000030000260000000000000000000000000000000000000000', // Bedding
    15: '0000000000000000000000000000005a7800000000000000000000000000000000000000', // Drying (Normal)
    22: '0200000000000300000000000100002d7800000000000000000000000000000000000000', // Rain / Snow
    28: '000000000000000000000000000000f00000000000000000000000000000000000000000', // Padding Care
    30: '02000000000000000000000005c80000000000000000000003000002c80001c80028c800', // Fine Dust
    31: '0200002300000500000a00000300003a0000000000000000000000000000000000000000', // Virus Care
    32: '0200002300000500000a00000300002b0000000000000000000000000000000000000000', // Jeans
    33: '0000000000000000000000000000001e7800000000000000000000000000000000000000', // Fur / Leather
    34: '020000000000020000000000017800057800000000000000000000000000000000000000', // Static Removal
}

// The start command's own layout, 46 bytes: the course and its two neighbours, the options byte with
// the record's own bit masks, the reserve time, then the recipe. Bytes 4-6 have been zero in every
// frame seen and are unaccounted for - the model JSON lists the four options as separate fields there,
// which the packed byte at 3 says they are not.
const CMD_LEN = 46
const CMD_COURSE = 0
const CMD_DOWNLOAD_SLOT = 1
const CMD_SMART_COURSE = 2
const CMD_FLAGS = 3 // rec[14]'s bits
const CMD_RESERVE_HOUR = 7
const CMD_RESERVE_MINUTE = 8
const CMD_RECIPE = 9
// The first duration carries an extra high bit. What it means is not known - it is set on both frames
// this appliance was recorded being sent, a start and a course download, and it is the one byte that
// does not fall out of the model JSON. It is reproduced rather than explained.
const RECIPE_MARKER = 0x80

export function startPayload(course: number): Buffer | undefined {
    const recipe = RECIPE[course]
    if (!recipe) return undefined

    const payload = Buffer.alloc(CMD_LEN)
    payload[CMD_COURSE] = course
    payload[CMD_DOWNLOAD_SLOT] = 1
    payload[CMD_SMART_COURSE] = 0
    payload[CMD_FLAGS] = FLAG_INITIAL_BIT
    payload[CMD_RESERVE_HOUR] = 0
    payload[CMD_RESERVE_MINUTE] = 0
    Buffer.from(recipe, 'hex').copy(payload, CMD_RECIPE)
    payload[CMD_RECIPE] |= RECIPE_MARKER
    return payload
}

// Resuming is a frame of its own: one byte shorter - the download slot is left out - and empty apart
// from the course, since the cabinet already knows what it was in the middle of. The cleared initial
// bit is what tells it to carry on rather than start again.
export function resumePayload(course: number): Buffer {
    const payload = Buffer.alloc(CMD_LEN - 1)
    payload[CMD_COURSE] = course
    return payload
}

// What a Home Assistant select can offer: the courses this handler knows how to start.
const SELECTABLE = Object.keys(RECIPE).map((code) => COURSE[Number(code)])

export default class Device extends AABBDevice {
    private readonly course = new CourseSelection(RECIPE)
    private state = STATE_OFF

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
                    // Two entities for one idea, because the appliance keeps them apart: "Course" above
                    // is the program the cabinet has selected, this is what Start will ask for. They
                    // agree until one is changed here, and the panel's own selection brings them back
                    // together.
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
                        state_class: 'total_increasing', // climbs during the cycle, resets to 0 at the next
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
        if (reportCommandAck(buf, DEV_BYTE, this.id)) return

        const rec = currentRecord(buf, DEV_BYTE, PAYLOAD_LEN)
        if (!rec) return

        const state = rec[STATE_OFFSET]
        const isOff = state === STATE_OFF
        this.state = state

        this.course.follow(rec[COURSE_OFFSET])
        if (this.course.selected) this.publishProperty('course_select', COURSE[this.course.selected])

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

    // The cabinet only obeys any of this with Remote Start armed on its own panel, which is a deliberate
    // piece of LG's design and not something a command can switch on. The remote_start sensor above says
    // whether it is armed.
    setProperty(prop: string, mqttValue: string) {
        if (prop === 'course_select') {
            const code = codeOf(COURSE, mqttValue)
            if (code === undefined || !(code in RECIPE)) return
            this.course.select(code)
            this.publishProperty('course_select', mqttValue)
        }

        if (prop === 'start') {
            const payload =
                this.state === STATE_PAUSED ? resumePayload(this.course.selected) : startPayload(this.course.selected)
            if (payload) this.send(courseControl(payload))
        }

        if (prop === 'pause') this.send(shortControl(CONTROL_PAUSE))
        if (prop === 'power_off') this.send(shortControl(CONTROL_POWER_OFF))
    }
}
