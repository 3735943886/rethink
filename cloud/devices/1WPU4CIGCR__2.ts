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
 *   0x1F  the dispensed-water counters, six 16-bit big-endian totals.
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
 *   15-18 the self-clean schedule, 8 / 4 / 16 / 0 - the 4th of August at 16:00
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
 * cloud-side and served by a separate energy API. What the appliance itself counts is water.
 *
 * Read-only, and the model agrees: Config says supportControl false, and the cloud reports the
 * appliance as controllableYn "N".
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

// The model writes its "this unit has no such thing" value as 255 and names it IGNORE.
const IGNORE = 255

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

// The counters, in the order Config.waterConfig lists the taps.
const COUNTERS = [
    { key: 'hot_water_total', name: 'Hot water dispensed' },
    { key: 'normal_water_total', name: 'Purified water dispensed' },
    { key: 'cold_water_total', name: 'Cold water dispensed' },
    { key: 'sterilised_water_total', name: 'Sterilised water dispensed' },
    { key: 'mineral_water_total', name: 'Mineral water dispensed' },
    { key: 'sparkling_water_total', name: 'Sparkling water dispensed' },
]

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

                    default_water: sensor('default_water', 'Default water', 'mdi:water-outline', {
                        entity_category: 'diagnostic',
                    }),
                    default_water_amount: sensor('default_water_amount', 'Default amount', 'mdi:cup-outline', {
                        entity_category: 'diagnostic',
                    }),

                    auto_care: binarySensor('auto_care', 'Auto care', 'mdi:auto-fix', {
                        entity_category: 'diagnostic',
                    }),
                    button_sound: binarySensor('button_sound', 'Button sound', 'mdi:volume-high', {
                        entity_category: 'diagnostic',
                    }),
                    not_use_notice: binarySensor('not_use_notice', 'Unused-water notice', 'mdi:bell-outline', {
                        entity_category: 'diagnostic',
                    }),

                    ...Object.assign(
                        {},
                        ...COUNTERS.map((c) => ({
                            [c.key]: sensor(c.key, c.name, 'mdi:water-plus-outline', {
                                device_class: 'volume',
                                unit_of_measurement: 'mL',
                                // the appliance only ever adds to these
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

        // A date without a year and a time, as the panel sets it. Published as text rather than a
        // timestamp because there is no year to build one from.
        const pad = (n: number) => String(n).padStart(2, '0')
        this.publishProperty(
            'sterilize_schedule',
            `${pad(p[STERILIZE_MONTH])}-${pad(p[STERILIZE_DAY])} ${pad(p[STERILIZE_HOUR])}:${pad(p[STERILIZE_MIN])}`,
        )

        // tempUnit and amountUnit are read but not published: this unit reports Celsius and
        // millilitres, the entities carry those units already, and neither has ever changed.
        void TEMP_UNIT
        void AMOUNT_UNIT
    }

    private processCounters(p: Buffer) {
        COUNTERS.forEach((c, i) => this.publishProperty(c.key, p.readUInt16BE(i * 2)))
    }
}
