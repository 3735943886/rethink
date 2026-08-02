import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import AABBDevice from './aabb_device'
import { currentRecord } from './monitoring_record'

// LG "2nd Mini Washer" - the pedestal drawer washer sold in Korea, matched on modelId "Pd0F_F",
// deviceType 201. AABB frames start with 0x20 and carry a 25-byte monitoring record (see
// monitoring_record.ts).
//
// This appliance switches its own Wi-Fi module off when it has nothing to do, so it spends most of its
// life offline and only appears on the wire while it is powered on or running. That is normal for the
// model, not a fault - Home Assistant will show its entities as unavailable in between.
//
// The offsets below were read out of the appliance's own cloud rather than guessed: with the unit
// bridged, a fromDevice frame whose payload byte i held the value i was injected, and the cloud replied
// with its decoded washerDryer state naming each field beside the value it had been handed
// (state=0, remainTimeHour=1, ... soak=24). A second frame carrying i+100 repeated the exercise with
// values no enum defines, so every field came back as "NOT_DEFINE_VALUE value:1xx" and confirmed the
// same byte a second time. The option bits were pinned by a nine-round sweep encoding (byte, bit) as a
// binary word, and the course codes by stepping rec[5] through every value and reading back the name
// the cloud gave it.
const DEV_BYTE = 0x20
const PAYLOAD_LEN = 25

const STATE_OFFSET = 0
const REMAIN_HOUR_OFFSET = 1
const REMAIN_MIN_OFFSET = 2
const INITIAL_HOUR_OFFSET = 3
const INITIAL_MIN_OFFSET = 4
const COURSE_OFFSET = 5
const ERROR_OFFSET = 6
const SPIN_OFFSET = 8
const TEMP_OFFSET = 9
const RINSE_OFFSET = 10
const RESERVE_HOUR_OFFSET = 12
const RESERVE_MIN_OFFSET = 13
// rec[14], rec[15] and rec[16]: three option bitfields.
const FLAGS_OFFSET = 14
const FLAG_CHILD_LOCK = 0x01
const FLAG_AUDIBLE_DIAGNOSIS = 0x02
const FLAG_DOOR_LOCK = 0x08
const OPT2_OFFSET = 15
const OPT2_STERILIZE = 0x02
const OPT2_WARM_WATER = 0x10
const OPT3_OFFSET = 16
const OPT3_REMOTE_START = 0x04 // 0x01 initialBit, 0x02 wifiSDS: protocol bookkeeping, not settings

const STATE_OFF = 0

const STATE: Record<number, string> = {
    0: 'Off',
    1: 'Initial',
    2: 'Paused',
    3: 'Sensing',
    4: 'Soaking',
    5: 'Washing',
    6: 'Rinsing',
    7: 'Spinning',
    8: 'Complete',
    9: 'Reserved',
    10: 'Firmware update',
    11: 'Diagnosis',
}

// Course codes, each one named by the cloud during the sweep. Codes 1-7 are the programs this unit's
// dial actually has; the rest belong to the same family table and are kept so a sibling model reports
// something better than "unknown".
const COURSE: Record<number, string> = {
    0: 'None',
    1: 'Small Load',
    2: 'Underwear',
    3: 'Wool',
    4: 'Light Boil',
    5: 'Baby Care',
    6: 'Rinse + Spin',
    7: 'Tub Clean',
    8: 'Spin only',
    9: 'Hand Wash',
    10: 'Speed Wash',
    11: 'Active Wear',
    12: 'Intimate',
    13: 'Cotton Eco (full)',
    14: 'Cotton Eco (half)',
    15: 'Cotton 20',
}

const ERROR: Record<number, string> = {
    0: 'OK',
    1: 'Water supply error (IE)',
    2: 'Water drain error (OE)',
    3: 'Out of balance error (UE)',
    4: 'Door open error (DE1)',
    5: 'Water level sensor error (PE)',
    8: 'Door error (dO)',
    9: 'Locked motor error (LE)',
    10: 'Water supply error (AE)',
    11: 'Temperature sensor error (TE)',
    12: 'Overfill error (FE)',
    16: 'Door lock error (DE2)',
    27: 'Unknown error (FF)',
    36: 'Unknown error (E7)',
}

// Wash temperature. The two "cold" entries are distinct settings on this model (tap cold and the
// cold-wash option), everything else is the water temperature in °C - so this reads as text rather than
// as a temperature entity.
const TEMP: Record<number, string> = {
    0: 'Cold',
    1: 'Cold wash',
    30: '30 °C',
    35: '35 °C',
    38: '38 °C',
    40: '40 °C',
    60: '60 °C',
    90: '90 °C',
}

export default class Device extends AABBDevice {
    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq)
        this.setConfig(
            allowExtendedType({
                ...HADevice.config(meta, { name: 'LG Mini Washer' }),
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
                    spin: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-spin',
                        state_topic: '$this/spin',
                        name: 'Spin',
                        icon: 'mdi:autorenew',
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
                    sterilize: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-sterilize',
                        state_topic: '$this/sterilize',
                        name: 'Sterilize',
                        icon: 'mdi:bacteria-outline',
                    },
                    warm_water: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-warm_water',
                        state_topic: '$this/warm_water',
                        name: 'Warm water',
                        icon: 'mdi:water-thermometer',
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
                    audible_diagnosis: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-audible_diagnosis',
                        state_topic: '$this/audible_diagnosis',
                        name: 'Audible diagnosis',
                        icon: 'mdi:volume-high',
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

        // Zeroed while off: the appliance keeps the last cycle's figures in these bytes, which would
        // otherwise read in Home Assistant as a countdown frozen mid-cycle.
        this.publishProperty('remaining_time', isOff ? 0 : rec[REMAIN_HOUR_OFFSET] * 60 + rec[REMAIN_MIN_OFFSET])
        this.publishProperty('initial_time', isOff ? 0 : rec[INITIAL_HOUR_OFFSET] * 60 + rec[INITIAL_MIN_OFFSET])
        this.publishProperty('reserve_time', isOff ? 0 : rec[RESERVE_HOUR_OFFSET] * 60 + rec[RESERVE_MIN_OFFSET])

        this.publishProperty('temp', TEMP[rec[TEMP_OFFSET]] ?? 'unknown')
        this.publishProperty('rinse', rec[RINSE_OFFSET])
        this.publishProperty('spin', rec[SPIN_OFFSET] ? 'ON' : 'OFF')

        const error = rec[ERROR_OFFSET]
        this.publishProperty('error', error !== 0 ? 'ON' : 'OFF')
        this.publishProperty('error_message', ERROR[error] ?? `Unknown error (${error})`)

        const flags = rec[FLAGS_OFFSET]
        this.publishProperty('child_lock', flags & FLAG_CHILD_LOCK ? 'ON' : 'OFF')
        this.publishProperty('audible_diagnosis', flags & FLAG_AUDIBLE_DIAGNOSIS ? 'ON' : 'OFF')
        this.publishProperty('door_lock', flags & FLAG_DOOR_LOCK ? 'ON' : 'OFF')

        const opt2 = rec[OPT2_OFFSET]
        this.publishProperty('sterilize', opt2 & OPT2_STERILIZE ? 'ON' : 'OFF')
        this.publishProperty('warm_water', opt2 & OPT2_WARM_WATER ? 'ON' : 'OFF')

        this.publishProperty('remote_start', rec[OPT3_OFFSET] & OPT3_REMOTE_START ? 'ON' : 'OFF')
        // Decoded by the cloud but not published: preState (rec[19]), and the smart/downloaded course
        // slots (rec[20], rec[23]) whose codes this unit never leaves at anything but its one stored
        // course. soilWash (rec[7]), waterLevel (rec[21]), waterFlow (rec[22]) and soak (rec[24]) are
        // decoded too, but the model JSON gives each of them exactly one value ("none"), so there is
        // nothing to show - this drawer washer has no such controls. rec[11], rec[17] and rec[18] are
        // named by nobody and have only ever been observed as zero.
    }
}
