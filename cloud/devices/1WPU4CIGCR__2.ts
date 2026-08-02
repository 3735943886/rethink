import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection, type ComponentInfo } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import AABBDevice from './aabb_device'

/**
 * LG water purifier (정수기), ThinQ model 1WPU4CIGCR__2, deviceType 103. The model description calls
 * it an "ATOM-U STS T20 내수 냉온정살" - cold, hot, purified and sterilised water.
 *
 * AABB again, and the same stacked-record shape as the cooktop and the dishwasher, with 0x12 where
 * those have 0x42 and 0x32. Discriminated by buf[1]:
 *   0xEC  status - two stacked 26-byte records, the previous state followed by the current one.
 *   0x1F  how much water has been drawn today, six 16-bit big-endian totals in millilitres.
 *   0xE2  six bytes, seen once. Its last byte held what the cold-water total read at the time, so it
 *         is probably a dispense event, but one frame is not a decoding.
 *   0xAF  five bytes, seen once, contents unrecognised.
 *
 * Unlike the appliances above, the mapping did not have to be guessed at: this model description
 * carries a MonitoringValue section that gives every field its own numeric index, so the record was
 * read straight off it and then checked against the real cloud's snapshot of the same moment. Every
 * byte below agreed with the cloud on the first reading:
 *
 *   0   monStatus            2 NORMAL
 *   1   cockState            1, then 0 - the tap's UV lamp, not a tap in use
 *   2   waterSelection       3 COLD_WATER
 *   3   waterAmountMode      1, and it moved to 2 and back as the panel switched 120ml / 250ml
 *   4   tempUnit             1 CELSIUS
 *   5   amountUnit           1 M_LITTER
 *   6   hotWaterTemp         255
 *   8   notUseNotice         1 ON
 *   10  defaultWaterSet      3 COLD_WATER
 *   11  defaultWaterAmountMode  1
 *   12  buttonSoundOnOff     1 ON
 *   13  voiceOnOff           255
 *   14  voiceVolume          255
 *   15-18 the next self-clean, 8 / 4 / 16 / 0 - which the app showed as the 5th at 01:00, so these
 *         are UTC and get shifted into local time before being published
 *   19  cleanMode            255
 *   20  autoCareOnOff        1 ON
 *   22  monDataRefresh       0
 *   25  appVersion           1
 *
 * A 255 is the model's own IGNORE, and every field carrying one is a feature Config says this unit
 * does not have - supportSoundSetting, supportEnergySaving and supportCleanMode are all false, and
 * the voice, energy-saving and clean-mode fields are exactly the ones reading 255. None of them is
 * published: an entity that can only ever say "ignore" is worse than no entity.
 *
 * Bytes 7, 9, 21, 23 and 24 are not published either. highSterilizeState and filterFlushingState
 * have to be among them - the cloud reports both, LG's own integration shows the first as
 * "High-temp sterilization", and both were OFF throughout - but nothing here moved either of them,
 * and a byte that has only ever read one value has not been identified. The sterilisation cycle
 * running once would settle it.
 *
 * Energy is not here at all. LG's integration shows this appliance's daily and monthly consumption,
 * and Config.supportEmonPowerMeter is true, but none of it is on the wire: it is accumulated
 * cloud-side and served by a separate energy API. What the appliance itself counts is water, and
 * only for the current day.
 *
 * The app shows several other things that are not on the wire either, and they are all history the
 * cloud keeps rather than state the appliance holds: when the water line and the outlet were last
 * cleaned, how many sterilisations ran last month, and when the filter was last changed.
 *
 * IT IS NOT READ-ONLY, THOUGH EVERYTHING SAYS IT IS
 * --------------------------------------------------
 * Config says supportControl false, ControlWifi carries an empty command set, and the cloud reports
 * the appliance as controllableYn "N". All three describe LG's legacy control path, which LG has
 * retired; the capability API that replaced it does control this model, and the frame it sends is
 * simply the record above, written back:
 *
 *   aa 20 f0 17 | 26-byte record, 0xff for every field to leave alone | ck bb
 *
 * So the read map below doubles as the write map. Five settings were sent to this appliance, each one
 * changed and then put back, and every one came back in the next status frame - which is the proof
 * that matters, since the appliance's `12 00 17` answer arrives whether or not it did anything:
 *
 *   [8] unused-water notice   [10] default water   [11] default amount
 *   [12] button sound         [20] auto care
 *
 * `f0 17` is not this model's own invention: the fridge drivers here build the same frame, 0xff-filled.
 *
 * Not offered: the four sterilisation-schedule bytes. They are writable in the same frame, but LG's own
 * schema carries only a time, and a time-only write moves the weekly run to a different weekday - the
 * appliance replaces its month/day anchor with the one implied by what it was sent. Reading it is
 * useful, writing it silently reschedules.
 */

const STATUS_FRAME_TYPE = 0xec
const RECORD_LENGTH = 26
const STATUS_FRAME_LENGTH = 2 + RECORD_LENGTH * 2
const CURRENT_RECORD_OFFSET = 2 + RECORD_LENGTH

const COUNTER_FRAME_TYPE = 0x1f
// Six 16-bit totals; the header is 2 bytes.
const COUNTER_FRAME_LENGTH = 2 + 6 * 2

const MON_STATUS = 0
const COCK_STATE = 1
const WATER_SELECTION = 2
const WATER_AMOUNT_MODE = 3
const TEMP_UNIT = 4
const AMOUNT_UNIT = 5
const NOT_USE_NOTICE = 8
const DEFAULT_WATER_SET = 10
const DEFAULT_WATER_AMOUNT_MODE = 11
const BUTTON_SOUND = 12
const STERILIZE_MONTH = 15
const STERILIZE_DAY = 16
const STERILIZE_HOUR = 17
const STERILIZE_MIN = 18
const AUTO_CARE = 20

// The model writes its "this unit has no such thing" value as 255 and names it IGNORE. The same 255
// means "leave this field as it is" in the other direction, which is what makes a write of one setting
// possible at all: the frame carries the whole record either way.
const IGNORE = 255
const SET_FRAME_TYPE = 0x17

// A write: the record with every field left alone but the ones named.
export function setRecord(fields: Record<number, number>): Buffer {
    const record = Buffer.alloc(RECORD_LENGTH, IGNORE)
    for (const [offset, value] of Object.entries(fields)) record[Number(offset)] = value
    return Buffer.concat([Buffer.from([0xf0, SET_FRAME_TYPE]), record])
}

// The name Home Assistant sends back, turned into the code the record carries, through the same table
// the state is published with.
function codeFor(table: Record<number, string>, name: string) {
    const found = Object.entries(table).find(([, label]) => label === name)
    return found ? Number(found[0]) : undefined
}

const MON_STATUS_NAMES: Record<number, string> = {
    0: 'Failed',
    1: 'Not working',
    2: 'Normal',
}

// cockState is the UV lamp that sterilises the tap, not water coming out of it: the model labels 0
// @WP_WAITING_V2_W and the other two @WP_COCK_CLEANING_V2_W, and LG's own integration shows this
// field as "UVnano". There is nothing on the wire that says water is being drawn - the dispensed
// totals below are how a draw shows up, after the fact.
const COCK_STATE_NAMES: Record<number, string> = {
    0: 'Standby',
    1: 'Cleaning',
    2: 'Cleaning (manual)',
}

const WATER_NAMES: Record<number, string> = {
    1: 'Hot',
    2: 'Normal',
    3: 'Cold',
    4: 'Sterilised',
}

// The model gives the amounts as labels rather than numbers because the fourth is not one.
const AMOUNT_NAMES: Record<number, string> = {
    1: '120 ml',
    2: '250 ml',
    3: '500 ml',
    4: 'Continuous',
}

const DEFAULT_WATER_NAMES: Record<number, string> = {
    1: 'Last used',
    2: 'Normal',
    3: 'Cold',
}

// What the default may be set to, which is the amounts without "Continuous" - that one is the button
// being held down rather than a quantity to come back to, and the model's own defaultWaterAmountMode
// enum stops at three.
const DEFAULT_AMOUNT_NAMES: Record<number, string> = {
    1: AMOUNT_NAMES[1],
    2: AMOUNT_NAMES[2],
    3: AMOUNT_NAMES[3],
}

// The counters, in the order Config.waterConfig lists the taps. They are today's totals, not
// lifetime ones - the app presents them under 오늘 (today) and they start again each day - so the
// entities are state_class total_increasing, which is the one that expects to be reset.
const COUNTERS = [
    { key: 'hot_water_total', name: 'Hot water today' },
    { key: 'normal_water_total', name: 'Purified water today' },
    { key: 'cold_water_total', name: 'Cold water today' },
    { key: 'sterilised_water_total', name: 'Sterilised water today' },
    { key: 'mineral_water_total', name: 'Mineral water today' },
    { key: 'sparkling_water_total', name: 'Sparkling water today' },
]

/*
 * When the appliance next sterilises itself, which it carries as a month, day, hour and minute with
 * no year - and in UTC. The wire read 08-04 16:00 while the app showed 8.5 01:00, exactly the nine
 * hours this appliance's timezone is ahead, so the four bytes are shifted into local time before
 * being published. The year is taken as the current one, which is only used to get the length of
 * the month right when the shift rolls the date over.
 *
 * The schedule itself repeats weekly - the app calls it 매주 수요일 01:00 - so this is the next run
 * rather than a one-off, and it moves on by a week once it has happened.
 */
function sterilizeSchedule(month: number, day: number, hour: number, minute: number) {
    const pad = (n: number) => String(n).padStart(2, '0')
    if (month < 1 || month > 12 || day < 1 || day > 31) return 'unknown'

    const local = new Date(Date.UTC(new Date().getUTCFullYear(), month - 1, day, hour, minute))
    return `${pad(local.getMonth() + 1)}-${pad(local.getDate())} ${pad(local.getHours())}:${pad(local.getMinutes())}`
}

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

/*
 * The settings that can be written. Their state still comes from the appliance rather than from what
 * was asked for: the record arrives a second after the write, so there is nothing to assume and
 * nothing to roll back if the appliance declines.
 */
function select(id: string, name: string, icon: string, options: string[]): ComponentInfo {
    return allowExtendedType({
        platform: 'select',
        unique_id: `$deviceid-${id}`,
        state_topic: `$this/${id}`,
        command_topic: `$this/${id}/set`,
        name,
        icon,
        options,
        entity_category: 'config',
    })
}

function toggle(id: string, name: string, icon: string): ComponentInfo {
    return allowExtendedType({
        platform: 'switch',
        unique_id: `$deviceid-${id}`,
        state_topic: `$this/${id}`,
        command_topic: `$this/${id}/set`,
        name,
        icon,
        entity_category: 'config',
    })
}

export default class Device extends AABBDevice {
    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq)
        this.setConfig(
            allowExtendedType({
                ...HADevice.config(meta, { name: 'LG Water Purifier' }),
                components: {
                    uvnano: sensor('uvnano', 'UVnano', 'mdi:auto-fix'),
                    water_selection: sensor('water_selection', 'Water', 'mdi:water'),
                    water_amount: sensor('water_amount', 'Amount', 'mdi:cup-outline'),

                    status: sensor('status', 'Status', 'mdi:water-check', { entity_category: 'diagnostic' }),
                    sterilize_schedule: sensor('sterilize_schedule', 'Self-clean schedule', 'mdi:calendar-clock', {
                        entity_category: 'diagnostic',
                    }),

                    default_water: select(
                        'default_water',
                        'Default water',
                        'mdi:water-outline',
                        Object.values(DEFAULT_WATER_NAMES),
                    ),
                    default_water_amount: select(
                        'default_water_amount',
                        'Default amount',
                        'mdi:cup-outline',
                        // Continuous is a way of holding the button down, not a default to come back to.
                        Object.values(DEFAULT_AMOUNT_NAMES),
                    ),

                    auto_care: toggle('auto_care', 'Auto care', 'mdi:auto-fix'),
                    button_sound: toggle('button_sound', 'Button sound', 'mdi:volume-high'),
                    not_use_notice: toggle('not_use_notice', 'Unused-water notice', 'mdi:bell-outline'),

                    ...Object.assign(
                        {},
                        ...COUNTERS.map((c) => ({
                            [c.key]: sensor(c.key, c.name, 'mdi:water-plus-outline', {
                                device_class: 'volume',
                                unit_of_measurement: 'mL',
                                state_class: 'total_increasing',
                            }),
                        })),
                    ),
                },
            }),
        )
    }

    processAABB(buf: Buffer) {
        if (buf[0] !== 0x12) return

        if (buf[1] === STATUS_FRAME_TYPE && buf.length === STATUS_FRAME_LENGTH) {
            // The frame restates the previous record so a listener that missed one can still see
            // what changed. We only ever want where the appliance is now.
            this.processStatus(buf.subarray(CURRENT_RECORD_OFFSET))
        } else if (buf[1] === COUNTER_FRAME_TYPE && buf.length === COUNTER_FRAME_LENGTH) {
            this.processCounters(buf.subarray(2))
        }
    }

    private processStatus(p: Buffer) {
        this.publishProperty('status', MON_STATUS_NAMES[p[MON_STATUS]] ?? 'unknown')
        this.publishProperty('uvnano', COCK_STATE_NAMES[p[COCK_STATE]] ?? 'unknown')

        this.publishProperty('water_selection', WATER_NAMES[p[WATER_SELECTION]] ?? 'unknown')
        this.publishProperty('water_amount', AMOUNT_NAMES[p[WATER_AMOUNT_MODE]] ?? 'unknown')

        this.publishProperty('default_water', DEFAULT_WATER_NAMES[p[DEFAULT_WATER_SET]] ?? 'unknown')
        this.publishProperty('default_water_amount', AMOUNT_NAMES[p[DEFAULT_WATER_AMOUNT_MODE]] ?? 'unknown')

        this.publishProperty('auto_care', p[AUTO_CARE] === 1 ? 'ON' : 'OFF')
        this.publishProperty('button_sound', p[BUTTON_SOUND] === 1 ? 'ON' : 'OFF')
        this.publishProperty('not_use_notice', p[NOT_USE_NOTICE] === 1 ? 'ON' : 'OFF')

        this.publishProperty(
            'sterilize_schedule',
            sterilizeSchedule(p[STERILIZE_MONTH], p[STERILIZE_DAY], p[STERILIZE_HOUR], p[STERILIZE_MIN]),
        )

        // tempUnit and amountUnit are read but not published: this unit reports Celsius and
        // millilitres, the entities carry those units already, and neither has ever changed.
        void TEMP_UNIT
        void AMOUNT_UNIT
    }

    private processCounters(p: Buffer) {
        COUNTERS.forEach((c, i) => this.publishProperty(c.key, p.readUInt16BE(i * 2)))
    }

    // Nothing is published from here. The appliance sends a status frame about a second after taking a
    // write, so the entity follows what the appliance says rather than what it was asked for - and a
    // setting the appliance declines simply stays where it was.
    setProperty(prop: string, mqttValue: string) {
        const offset = {
            default_water: DEFAULT_WATER_SET,
            default_water_amount: DEFAULT_WATER_AMOUNT_MODE,
            auto_care: AUTO_CARE,
            button_sound: BUTTON_SOUND,
            not_use_notice: NOT_USE_NOTICE,
        }[prop]
        if (offset === undefined) return

        let value: number | undefined
        if (prop === 'default_water') value = codeFor(DEFAULT_WATER_NAMES, mqttValue)
        else if (prop === 'default_water_amount') value = codeFor(DEFAULT_AMOUNT_NAMES, mqttValue)
        else value = mqttValue === 'ON' ? 1 : 0

        if (value === undefined) return
        this.send(setRecord({ [offset]: value }))
    }
}
