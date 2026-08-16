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

// LG front-load washer sold in Korea - matched on modelId "F24VDD" (an AI DD 24 kg drum washer),
// deviceType 201. AABB frames start with 0x20 and are discriminated by the second byte:
//   0xEC  the regular status report, two stacked 34-byte monitoring records (see monitoring_record.ts),
//   0xEB / 0xE2  the same record on its own, after a (re)connect and at the start of a cycle,
//   0x00  the answer to a command (see monitoring_command.ts),
//   0x31  two board serial numbers in ASCII, each with a counter beside it,
//   0xBD / 0xCD  ~405-byte diagnostic dumps, and 0x72, 0xD8, 0x19 - not decoded.
//
// The dumps are telemetry rather than settings: 0xCD arrives every five minutes while a cycle runs and
// 0xBD at each state change, and both begin with a copy of the live state - dump[8] is the state code,
// dump[9:11] the remaining time, dump[35:37] the same energy counter as rec[17:19], matched against 60
// consecutive samples. The rest is sensor history in rolling groups of four to five bytes. None of it
// is decoded here: nothing names those bytes, and the obvious reading - that the ramp climbing to ~88
// is the water temperature - dies on the evidence, since it peaks at the same value in a 60 °C wash and
// a 95 °C one.
//
// The offsets below came from the appliance's own cloud rather than from static analysis: with the
// washer bridged, a fromDevice frame whose payload byte i held the value i was injected, and the cloud
// answered with its decoded washerDryer state naming each field beside the value it had been handed
// (state=0, remainTimeHour=1, ... laundryTexture=27). A second frame carrying i+100 gave every field a
// value no enum defines, so each came back as "NOT_DEFINE_VALUE value:1xx" and confirmed its byte a
// second time - that pass is what moved the operating course off rec[20], where the first pass had
// looked like it lived, onto rec[22]. The option bits were pinned by a nine-round sweep that encodes
// (byte, bit) as a binary word, and the course table by stepping rec[5] through every code and reading
// back the name the cloud gave it. Everything was then checked against a real wash: the record
// 17 01 21 01 2c 06 00 03 03 04 03 ... 20 46 decodes as Running, 1h33m left of a 1h44m Heavy Duty at
// heavy soil / medium spin / 60 °C / 3 rinses with the door locked and Add Garment available, matching
// the cloud's own snapshot of this unit field for field.
const DEV_BYTE = 0x20
const PAYLOAD_LEN = 34

const STATE_OFFSET = 0
const REMAIN_HOUR_OFFSET = 1
const REMAIN_MIN_OFFSET = 2
const INITIAL_HOUR_OFFSET = 3
const INITIAL_MIN_OFFSET = 4
// rec[5] is the course as selected on the dial; rec[22] is the one the machine is actually running,
// which differs whenever the dial sits on "Downloaded course" or a smart course has been sent to it.
const COURSE_OFFSET = 5
const ERROR_OFFSET = 6
const SOIL_OFFSET = 7
const SPIN_OFFSET = 8
const TEMP_OFFSET = 9
const RINSE_OFFSET = 10
const RESERVE_HOUR_OFFSET = 12
const RESERVE_MIN_OFFSET = 13
// rec[14], rec[15] and rec[16]: three option bitfields.
const FLAGS_OFFSET = 14
const FLAG_CREASE_CARE = 0x01
const FLAG_FRESH_CARE = 0x02
const FLAG_RINSE_HOLD = 0x04
const FLAG_CHILD_LOCK = 0x08
const FLAG_STEAM = 0x10
const FLAG_REMOTE_START = 0x20
const FLAG_FAVORITE = 0x40
const OPT2_OFFSET = 15
const OPT2_ALARM = 0x02
const OPT2_DOOR_LOCK = 0x04
const OPT2_ADD_LOAD = 0x40 // "Add Garment" - the door may be opened to throw in a forgotten sock
const OPT2_TURBO_SHOT = 0x80
// rec[16] carries only the cloud's initialBit (0x20) and the AI DD panel LED (0x40), neither of which
// is a setting worth an entity. The initialBit does matter in a command, where it is what separates
// starting a cycle from resuming a paused one.
const OPT3_INITIAL_BIT = 0x20
// rec[17:19]: energy used by the running cycle, big-endian, in Wh. The cloud does not decode it for
// this model, but the styler in the same protocol family publishes exactly these two bytes as
// energyMonitoring, and the counter behaves the part: it climbs at ~26 Wh/min while the washer heats
// and finished a 95 °C boil wash at 1684 Wh.
const ENERGY_OFFSET = 17
const OP_COURSE_OFFSET = 22
// rec[20] is the course sitting in the download slot. Confirmed against real traffic: this washer sends
// 0x41 there and the cloud's snapshot of the same moment reads downloadedCourse = DEODORIZATION, the
// name code 65 was given during the sweep.
const DOWNLOAD_COURSE_OFFSET = 20
// rec[21] counts wash cycles since the last Tub Clean; rec[23] is the AI DD load estimate, 0-4.
const TUB_CLEAN_COUNT_OFFSET = 21
const LOAD_LEVEL_OFFSET = 23

const STATE_OFF = 0
const STATE_PAUSED = 6

// state and preState share this table (the model JSON gives both the same enum).
const STATE: Record<number, string> = {
    0: 'Off',
    5: 'Initial',
    6: 'Paused',
    7: 'Error auto-off',
    10: 'Reserved',
    20: 'Sensing',
    21: 'Draining',
    22: 'Detergent dosing',
    23: 'Washing',
    24: 'Pre-wash',
    30: 'Rinsing',
    31: 'Rinse hold',
    40: 'Spinning',
    50: 'Drying',
    60: 'Complete',
    61: 'Refreshing',
    83: 'Freeze protection (initial)',
    84: 'Freeze protection (running)',
    85: 'Freeze protection (paused)',
    101: 'Audible diagnosis',
}

// Dial course codes, each one named by the cloud during the sweep. The names are the ones the panel
// and the app actually print, taken from this model's language pack rather than from the enum
// identifiers - which have drifted: code 1 is STEAM_CLEANING on the wire but the model JSON's own
// comment records it being renamed, and the machine calls it Steam Refresh.
const COURSE: Record<number, string> = {
    0: 'None',
    1: 'Steam Refresh', // 스팀리프레쉬 (enum STEAM_CLEANING)
    2: 'Allergy Care', // 알러지케어
    3: 'Functional Wear', // 기능성의류 (enum UTILITY)
    4: 'Economy Boil', // 알뜰삶음 (enum SPEEDBOIL)
    5: 'Baby Wear', // 아기옷
    6: 'Heavy Duty', // 찌든때
    7: 'Cotton', // 표준
    8: 'Speed Wash', // 스피드워시
    9: 'Quiet', // 조용조용 (enum SILENT)
    10: 'Colour Care', // 컬러케어
    11: 'Duvet', // 이불
    12: 'Lingerie / Wool', // 란제리/울
    13: 'Rinse + Spin', // 헹굼+탈수
    14: 'Downloaded course', // 다운로드코스
    15: 'Tub Clean', // 통살균
}

// The course the machine actually runs, a wider table than the dial's - a downloaded or smart course
// shows up here while rec[5] only says "Downloaded course".
const OP_COURSE: Record<number, string> = {
    0: 'None',
    1: 'Steam Cleaning',
    2: 'Allergy Care',
    3: 'Utility',
    4: 'Speed Wash',
    5: 'Cotton',
    6: 'Cotton Eco',
    7: 'Silent',
    8: 'Lingerie / Wool',
    9: 'Duvet',
    10: 'Tub Clean',
    11: 'Baby Wear',
    12: 'Easy Care',
    13: 'Boil Wash',
    14: 'Heavy Duty',
    15: 'Cold Wash',
    16: 'Colour Care',
    17: 'Rinse + Spin',
    18: 'Smart Energy',
    19: 'Blanket',
    20: 'Air Wash',
    21: 'Spin only',
    22: 'Double Rinse',
    23: 'Speed Dry',
    24: 'Speed Wash + Dry',
    25: 'Pet Care',
    26: 'Quick Tub Clean',
}

// Downloadable (smart) courses, from the same sweep. Codes 61, 72 and 76 are gaps the cloud declines to
// name, so they fall through to 'unknown' like anything else it does not recognise.
const DOWNLOAD_COURSE: Record<number, string> = {
    0: 'None',
    51: 'Cold Wash',
    52: 'Small Load',
    53: 'Skin Care',
    54: 'Rainy Day',
    55: 'Sweat Stains',
    56: 'Single Garments',
    57: "Kids' Wear",
    58: 'Shirts',
    59: 'School Uniform',
    60: 'Static Reduce',
    62: 'Colour Care',
    63: 'Spin only',
    64: 'Air Wash',
    65: 'Deodorisation',
    66: 'Bedding Care',
    67: 'Cloth Care',
    68: 'Smart Rinse',
    69: 'Eco Wash',
    70: 'Double Rinse',
    71: 'Heavy Duty',
    73: 'Wash + Dry',
    74: 'Silent Wash',
    75: 'Wrinkle Care',
    77: 'Rinse + Spin',
    78: 'Baby Wear',
    79: 'Sportswear',
    80: 'Towels',
    81: 'Shirts (1 h)',
    82: 'Allergy Care',
    83: 'Hygiene',
    84: 'Speed Wash',
    85: 'Pet Care',
    86: 'Quick Tub Clean',
}

const SOIL: Record<number, string> = {
    0: 'None',
    1: 'Light',
    2: 'Normal',
    3: 'Heavy',
    4: 'Pre-wash',
    5: 'Soaking',
}

const SPIN: Record<number, string> = {
    0: 'No spin',
    1: 'Very low',
    2: 'Low',
    3: 'Medium',
    4: 'High',
    5: 'Extra high',
}

const TEMP: Record<number, string> = {
    0: 'None',
    1: 'Cold',
    2: '30 °C',
    3: '40 °C',
    4: '60 °C',
    5: '95 °C',
}

/*
 * What each dial course runs with: [operating course, soil, spin, temperature, rinses, steam,
 * TurboShot]. A start command carries the whole cycle, not just a course code, and these are the
 * values the appliance's own panel would fill in - taken from the model JSON's per-course defaults.
 *
 * Three of them are confirmed on the wire, from starts the ThinQ app was recorded making: Colour Care
 * (0a 02 02 02 03 ... 10), Heavy Duty (06 03 03 04 03 ... 0e) and Steam Refresh (01 02 00 00 00 ...
 * 01, with the steam bit set) match these rows byte for byte, including the operating course in the
 * last field - which is a second table's worth of codes and the part most likely to be wrong.
 *
 * The options a course fixes cannot be overridden here: the machine ignores steam on a course with no
 * steam step, and the app itself only offers what the course allows. Downloaded courses (dial code 14)
 * are left out - starting one means first sending the course data into the appliance's slot.
 */
const PRESET: Record<number, [number, number, number, number, number, boolean, boolean]> = {
    1: [1, 2, 0, 0, 0, true, false], // Steam Refresh
    2: [2, 2, 3, 0, 4, true, false], // Allergy Care
    3: [3, 2, 1, 0, 3, true, false], // Functional Wear
    4: [13, 2, 3, 5, 3, false, false], // Economy Boil
    5: [11, 2, 3, 0, 4, true, false], // Baby Wear
    6: [14, 3, 3, 4, 3, false, false], // Heavy Duty
    7: [5, 2, 4, 3, 2, false, true], // Cotton
    8: [4, 2, 3, 0, 1, true, true], // Speed Wash
    9: [7, 2, 2, 3, 4, false, false], // Quiet
    10: [16, 2, 2, 2, 3, false, false], // Colour Care
    11: [9, 2, 3, 1, 4, false, false], // Duvet
    12: [8, 2, 2, 1, 3, false, false], // Lingerie / Wool
    13: [17, 0, 3, 0, 1, false, false], // Rinse + Spin
    15: [10, 2, 3, 4, 2, false, false], // Tub Clean
}

// The start command's own layout. Its first fields are the settings in the order the model JSON lists
// them, then the three option bytes carrying the record's own bit masks, then the course to run and
// the smart course. The remaining nine bytes are padding to the declared length of 21.
//
// The same 21 bytes make up a course download - f0 25 03 15 in front of them instead of f0 26 - which
// is where the last two fields show themselves: sending Sweat Stains into the download slot came out as
// 0e 03 03 03 03 ... 0e 37, dial course 14 ("Downloaded course"), the settings, operating course 14
// (Heavy Duty) and smart course 55. Downloading is not implemented; the layout is shared, so noting it
// here keeps the two frames from being re-derived separately.
const CMD_LEN = 21
const CMD_COURSE = 0
const CMD_SOIL = 1
const CMD_SPIN = 2
const CMD_TEMP = 3
const CMD_RINSE = 4
const CMD_FLAGS = 7 // rec[14]'s bits
const CMD_OPT2 = 8 // rec[15]'s
const CMD_OPT3 = 9 // rec[16]'s
const CMD_OP_COURSE = 10

// What a Home Assistant select can offer: the courses this handler knows how to start.
const SELECTABLE = Object.keys(PRESET).map((code) => COURSE[Number(code)])

// Resuming is the same frame with the initial bit cleared - the appliance reads it as "carry on with
// what you were doing" and ignores the settings, which is why a resume needs no state of its own.
export function startPayload(course: number, resume: boolean): Buffer | undefined {
    const preset = PRESET[course]
    if (!preset) return undefined

    const [opCourse, soil, spin, temp, rinse, steam, turboShot] = preset
    const payload = Buffer.alloc(CMD_LEN)
    payload[CMD_COURSE] = course
    payload[CMD_SOIL] = soil
    payload[CMD_SPIN] = spin
    payload[CMD_TEMP] = temp
    payload[CMD_RINSE] = rinse
    payload[CMD_FLAGS] = FLAG_REMOTE_START | (steam ? FLAG_STEAM : 0)
    payload[CMD_OPT2] = turboShot ? OPT2_TURBO_SHOT : 0
    payload[CMD_OPT3] = resume ? 0 : OPT3_INITIAL_BIT
    payload[CMD_OP_COURSE] = opCourse
    return payload
}

const ERROR: Record<number, string> = {
    0: 'OK',
    1: 'Door lock error (DE2)',
    2: 'Water supply error (IE)',
    3: 'Water drain error (OE)',
    4: 'Out of balance error (UE)',
    5: 'Overfill error (FE)',
    6: 'Water level sensor error (PE)',
    7: 'Temperature sensor error (TE)',
    8: 'Locked motor error (LE)',
    9: 'Communication error (CE)',
    10: 'Heater error (dHE)',
    11: 'Power fail error (PF)',
    12: 'Unknown error (FF)',
    13: 'Unknown error (dCE)',
    14: 'Vibration sensor error (VS)',
    15: 'EEPROM error',
    16: 'Unknown error (PS)',
    17: 'Door open error (DE1)',
    18: 'Unknown error (LOE)',
    19: 'Door sensor error (DE4)',
}

export default class Device extends AABBDevice {
    private readonly course = new CourseSelection(PRESET)
    private state = STATE_OFF

    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq)
        this.setConfig(
            allowExtendedType({
                ...HADevice.config(meta, { name: 'LG Washer' }),
                components: {
                    power: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-power',
                        state_topic: '$this/power',
                        name: 'Power',
                        icon: 'mdi:washing-machine',
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
                    op_course: {
                        platform: 'sensor',
                        unique_id: '$deviceid-op_course',
                        state_topic: '$this/op_course',
                        name: 'Running course',
                        icon: 'mdi:play-circle-outline',
                        entity_category: 'diagnostic',
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
                    soil: {
                        platform: 'sensor',
                        unique_id: '$deviceid-soil',
                        state_topic: '$this/soil',
                        name: 'Soil level',
                        icon: 'mdi:liquid-spot',
                    },
                    spin: {
                        platform: 'sensor',
                        unique_id: '$deviceid-spin',
                        state_topic: '$this/spin',
                        name: 'Spin',
                        icon: 'mdi:autorenew',
                    },
                    temp: {
                        platform: 'sensor',
                        unique_id: '$deviceid-temp',
                        state_topic: '$this/temp',
                        name: 'Water temperature',
                        icon: 'mdi:thermometer',
                    },
                    rinse: {
                        platform: 'sensor',
                        unique_id: '$deviceid-rinse',
                        state_topic: '$this/rinse',
                        name: 'Rinse cycles',
                        icon: 'mdi:water-sync',
                        state_class: 'measurement',
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
                    load_level: {
                        platform: 'sensor',
                        unique_id: '$deviceid-load_level',
                        state_topic: '$this/load_level',
                        name: 'Load level',
                        icon: 'mdi:weight',
                        state_class: 'measurement',
                        entity_category: 'diagnostic',
                    },
                    tub_clean_count: {
                        platform: 'sensor',
                        unique_id: '$deviceid-tub_clean_count',
                        state_topic: '$this/tub_clean_count',
                        name: 'Cycles since Tub Clean',
                        icon: 'mdi:washing-machine-alert',
                        state_class: 'measurement',
                        entity_category: 'diagnostic',
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
                    turbo_shot: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-turbo_shot',
                        state_topic: '$this/turbo_shot',
                        name: 'TurboShot',
                        icon: 'mdi:rocket-launch',
                    },
                    crease_care: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-crease_care',
                        state_topic: '$this/crease_care',
                        name: 'Crease care',
                        icon: 'mdi:tshirt-crew-outline',
                    },
                    fresh_care: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-fresh_care',
                        state_topic: '$this/fresh_care',
                        name: 'Fresh care',
                        icon: 'mdi:air-filter',
                    },
                    rinse_hold: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-rinse_hold',
                        state_topic: '$this/rinse_hold',
                        name: 'Rinse hold',
                        icon: 'mdi:water-pause',
                    },
                    add_load: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-add_load',
                        state_topic: '$this/add_load',
                        name: 'Add Garment available',
                        icon: 'mdi:tshirt-crew',
                    },
                    favorite: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-favorite',
                        state_topic: '$this/favorite',
                        name: 'Favourite course',
                        icon: 'mdi:star',
                        entity_category: 'diagnostic',
                    },
                    alarm: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-alarm',
                        state_topic: '$this/alarm',
                        name: 'End-of-cycle sound',
                        icon: 'mdi:volume-high',
                        entity_category: 'diagnostic',
                    },
                    door_lock: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-door_lock',
                        state_topic: '$this/door_lock',
                        name: 'Door lock',
                        icon: 'mdi:lock', // NOT device_class 'lock' - that class is inverted (on = unlocked)
                        entity_category: 'diagnostic',
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
        this.publishProperty('op_course', OP_COURSE[rec[OP_COURSE_OFFSET]] ?? 'unknown')
        this.publishProperty('download_course', DOWNLOAD_COURSE[rec[DOWNLOAD_COURSE_OFFSET]] ?? 'unknown')

        // Zeroed while off: the appliance keeps the last cycle's figures in these bytes, which would
        // otherwise read in Home Assistant as a countdown frozen mid-cycle.
        this.publishProperty('remaining_time', isOff ? 0 : rec[REMAIN_HOUR_OFFSET] * 60 + rec[REMAIN_MIN_OFFSET])
        this.publishProperty('initial_time', isOff ? 0 : rec[INITIAL_HOUR_OFFSET] * 60 + rec[INITIAL_MIN_OFFSET])
        this.publishProperty('reserve_time', isOff ? 0 : rec[RESERVE_HOUR_OFFSET] * 60 + rec[RESERVE_MIN_OFFSET])

        this.publishProperty('soil', SOIL[rec[SOIL_OFFSET]] ?? 'unknown')
        this.publishProperty('spin', SPIN[rec[SPIN_OFFSET]] ?? 'unknown')
        this.publishProperty('temp', TEMP[rec[TEMP_OFFSET]] ?? 'unknown')
        this.publishProperty('rinse', rec[RINSE_OFFSET])
        this.publishProperty('energy', rec.readUInt16BE(ENERGY_OFFSET))
        this.publishProperty('load_level', rec[LOAD_LEVEL_OFFSET])
        this.publishProperty('tub_clean_count', rec[TUB_CLEAN_COUNT_OFFSET])

        const error = rec[ERROR_OFFSET]
        this.publishProperty('error', error !== 0 ? 'ON' : 'OFF')
        this.publishProperty('error_message', ERROR[error] ?? `Unknown error (${error})`)

        const flags = rec[FLAGS_OFFSET]
        this.publishProperty('crease_care', flags & FLAG_CREASE_CARE ? 'ON' : 'OFF')
        this.publishProperty('fresh_care', flags & FLAG_FRESH_CARE ? 'ON' : 'OFF')
        this.publishProperty('rinse_hold', flags & FLAG_RINSE_HOLD ? 'ON' : 'OFF')
        this.publishProperty('child_lock', flags & FLAG_CHILD_LOCK ? 'ON' : 'OFF')
        this.publishProperty('steam', flags & FLAG_STEAM ? 'ON' : 'OFF')
        this.publishProperty('remote_start', flags & FLAG_REMOTE_START ? 'ON' : 'OFF')
        this.publishProperty('favorite', flags & FLAG_FAVORITE ? 'ON' : 'OFF')

        const opt2 = rec[OPT2_OFFSET]
        this.publishProperty('alarm', opt2 & OPT2_ALARM ? 'ON' : 'OFF')
        this.publishProperty('door_lock', opt2 & OPT2_DOOR_LOCK ? 'ON' : 'OFF')
        this.publishProperty('add_load', opt2 & OPT2_ADD_LOAD ? 'ON' : 'OFF')
        this.publishProperty('turbo_shot', opt2 & OPT2_TURBO_SHOT ? 'ON' : 'OFF')
        // Decoded by the cloud but not published: preState (rec[19]), which Home Assistant's own history
        // covers; dryLevel (rec[11]), which stays "none" on a washer with no dryer; standby (rec[24])
        // and laundryTexture (rec[27]), for which the model JSON offers no value table at all. Nothing
        // names rec[25], rec[26] or rec[28:34] - the tail is constant across every record this washer
        // has sent.
    }

    // The appliance only obeys any of this with Remote Start armed on its own panel, which is a
    // deliberate piece of LG's design and not something a command can switch on: a washer that could
    // be started from the internet with the door open would be a different appliance. The remote_start
    // sensor above says whether it is armed.
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
