import TLVDevice from './tlv_device'
import { Device as Thinq2Device } from '../thinq2/device'
import { DeviceDiscovery, type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import * as TLV from '@/util/tlv'
import HADevice from './base'

/**
 * LG air purifier (공기청정기), ThinQ model AIR_910604_WW, deviceType 402.
 *
 * Same DualCool TLV family as RAC / DHUM / POT, and like POT and CST its async frames carry UART
 * header byte6 = 0xa7 rather than 0x87, so processData normalizes a copy before delegating.
 *
 * The tag map below was established live against the physical appliance: a values query (0x1f5=2)
 * dumped all 44 tags at once, then each unknown tag was given a distinct value in a synthesized
 * fromDevice frame and the real LG cloud's decoded property names were read back off its
 * notification feed. So these are the cloud's own names for these tags, not guesses:
 *
 *   wire   cloud property                            exposed as
 *   0x1f7  airState.operation                        fan power              (write-verified)
 *   0x1f9  airState.opMode                           operating-mode select  (write-verified)
 *   0x1fa  airState.windStrength                     fan preset mode        (write-verified)
 *   0x1fc  airState.tempState.unit                   -
 *   0x1fd  airState.tempState.current (raw/2 °C)     temperature (see below)
 *   0x1fe  airState.tempState.target  (raw/2 °C)     -
 *   0x21a  airState.reservation.sleepTime            sleep timer (min)      (write-verified)
 *   0x21b  airState.reservation.targetTimeToStop     -
 *   0x21c  airState.reservation.targetTimeToStart    -
 *   0x21e  airState.miscFuncState.watertankLight     -
 *   0x221  airState.diagCode                         error sensor
 *   0x226  airState.wMode.humidification             -
 *   0x240  airState.quality.overall                  air-quality sensor
 *   0x241  airState.quality.odor                     odour sensor
 *   0x24e  airState.lightingState.signal             청정표시등 switch      (write-verified)
 *   0x326  airState.circulate.strength               -
 *   0x327  airState.circulate.rotate                 -
 *   0x328  airState.miscFuncState.antiBugs           -
 *   0x333  airState.quality.PM1                      PM1 sensor
 *   0x334  airState.quality.PM2                      PM2.5 sensor
 *   0x335  airState.quality.PM10                     PM10 sensor
 *   0x336  airState.humidity.current                 humidity sensor
 *   0x33a  airState.filterMngStates.desorption       -
 *   0x355  airState.filterMngStates.useTime          filter life (with 0x356)
 *   0x356  airState.filterMngStates.maxTime          filter life (with 0x355)
 *   0x35f  airState.miscFuncState.airFast            -
 *   0x360  airState.miscFuncState.airRemoval         공기제균 switch        (write-verified)
 *   0x361  airState.miscFuncState.airUVDisinfection  -
 *   0x362  airState.miscFuncState.cleanDry           -
 *   0x363  airState.filterMngStates.useTimeTop       top-filter life (with 0x364)
 *   0x364  airState.filterMngStates.maxTimeTop       top-filter life (with 0x363)
 *   0x2ac  - the cloud does not name this one; left undecoded.
 *   0x2d7/0x2d8/0x2d9 repeat as a triple per mode - the unit's remembered wind strength for each
 *   operating mode. Resent with every mode/fan change; not a live state, so not exposed.
 *
 * The tags marked "-" are real and reported, but this unit reports every one of them as 0 and
 * nothing here could confirm the hardware has the feature at all, so they are deliberately not
 * exposed - an entity that silently does nothing is worse than no entity. They are listed so the
 * next capture can promote them.
 *
 * Two quirks, both established by driving the appliance:
 *
 * 1. A write while the unit is off is acknowledged and then ignored - the same behaviour RAC / CST
 *    / DHUM have. Sending 0x1f7=1 alongside the mode does work and starts the unit directly in that
 *    mode, so the mode and fan writes force the power tag on and attach it.
 *
 * 2. While the operating mode is Auto the unit drives the fan itself and a bare 0x1fa write is
 *    acknowledged and ignored. The same write in any other mode takes effect immediately. Nothing
 *    is done about this - it is the appliance deciding, and silently changing the user's mode to
 *    make a fan request stick would be worse. Picking a fan speed in Auto simply does nothing.
 *
 * 3. Setting the sleep timer switches 청정표시등 (0x24e) off by itself - the unit reports both tags
 *    in one frame. That is the appliance's own idea of a sleep setting, not something done here.
 *
 * The sleep timer counts down: written as 60 it is reported back as 60 and then 59 a minute later,
 * so the entity shows the live remaining time rather than what was requested. The model description
 * caps it at 420 minutes but the appliance accepted 480, and the model's own comment talks about 12
 * hour settings, so the entity allows the full 720 the sibling off-timer tag declares.
 *
 * Temperature is exposed as a diagnostic only. The scale is confirmed (the cloud reports raw/2, so
 * wire 63 came back as 31.5 °C), but this unit reads a steady 40 °C, and the model description
 * marks temperature display unsupported for it - so it looks like an internal sensor rather than
 * room air. Being diagnostic keeps it out of the way while still showing what the appliance says.
 */

// Operating modes. The capability response's 0x2c1 reads 0x1E000 - bits 13..16 - which selects
// exactly these four out of the model description's full opMode enum.
const MODES = ['circulator_clean', 'baby_care', 'dual_clean', 'auto']
const MODE_R: Record<number, string> = { 13: 'circulator_clean', 14: 'baby_care', 15: 'dual_clean', 16: 'auto' }
const MODE_W: Record<string, number> = { circulator_clean: 13, baby_care: 14, dual_clean: 15, auto: 16 }

// Wind strength. 0x2c2 reads 468 - bits 2, 4, 6, 7 and 8 - selecting these five.
const FAN_MODES = ['low', 'mid', 'high', 'power', 'auto']
const FAN_R: Record<number, string> = { 2: 'low', 4: 'mid', 6: 'high', 7: 'power', 8: 'auto' }
const FAN_W: Record<string, number> = { low: 2, mid: 4, high: 6, power: 7, auto: 8 }

const TAG_POWER = 0x1f7
const TAG_MODE = 0x1f9
const TAG_FAN = 0x1fa

const TAG_SLEEP_TIMER = 0x21a
const TAG_LIGHT = 0x24e
const TAG_STERILIZE = 0x360

const TAG_FILTER_REMAIN = 0x355
const TAG_FILTER_MAX = 0x356
const TAG_TOP_FILTER_REMAIN = 0x363
const TAG_TOP_FILTER_MAX = 0x364

export default class Device extends TLVDevice {
    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq)

        // NB: the friendly name goes in device.name - a top-level `name` key is rejected by HA's
        // device-based discovery schema.
        const config: DeviceDiscovery = allowExtendedType({
            ...HADevice.config(meta, { name: 'LG Air Purifier' }),
            components: {
                fan: {
                    platform: 'fan',
                    unique_id: '$deviceid-fan',
                    name: null,
                    icon: 'mdi:air-purifier',
                    preset_modes: FAN_MODES,
                },
            },
        })

        // Power - the fan's main ON/OFF.
        this.addField(config, {
            id: TAG_POWER,
            name: '',
            comp: 'fan',
            read_xform: (raw) => (raw ? 'ON' : 'OFF'),
            write_xform: (val) => (val === 'ON' ? 1 : 0),
            // when turning on, restore mode and fan speed in the same frame
            write_attach: (raw) => (raw ? [TAG_MODE, TAG_FAN] : []),
        })

        // Wind strength -> preset_mode_command_topic / preset_mode_state_topic.
        this.addField(config, {
            id: TAG_FAN,
            name: 'preset_mode',
            comp: 'fan',
            read_xform: (raw) => FAN_R[raw],
            write_xform: (val) => {
                this.raw_clip_state[TAG_POWER] = 1 // ignored while off (quirk 1)
                return FAN_W[val]
            },
            write_attach: [TAG_POWER, TAG_MODE],
        })

        // Operating mode - its own select, since the fan platform's one preset slot is the speed.
        config.components['mode'] = allowExtendedType({
            platform: 'select',
            unique_id: '$deviceid-mode',
            name: 'Mode',
            icon: 'mdi:tune-variant',
            options: MODES,
        })
        this.addField(config, {
            id: TAG_MODE,
            name: '',
            comp: 'mode',
            read_xform: (raw) => MODE_R[raw],
            write_xform: (val) => {
                this.raw_clip_state[TAG_POWER] = 1 // ignored while off (quirk 1)
                return MODE_W[val]
            },
            write_attach: [TAG_POWER, TAG_FAN],
        })

        this.addParticulate(config, 'pm1', 0x333, 'PM1', 'pm1')
        this.addParticulate(config, 'pm25', 0x334, 'PM2.5', 'pm25')
        this.addParticulate(config, 'pm10', 0x335, 'PM10', 'pm10')

        // The unit's own 1..4 air-quality and odour indices, as the app shows them.
        this.addReadout(config, 'air_quality', 0x240, 'Air quality', 'mdi:weather-hazy')
        this.addReadout(config, 'odor', 0x241, 'Odour', 'mdi:scent')

        config.components['humidity'] = allowExtendedType({
            platform: 'sensor',
            unique_id: '$deviceid-humidity',
            name: 'Humidity',
            device_class: 'humidity',
            unit_of_measurement: '%',
            state_class: 'measurement',
        })
        this.addField(config, { id: 0x336, name: '', comp: 'humidity', writable: false })

        config.components['temperature'] = allowExtendedType({
            platform: 'sensor',
            unique_id: '$deviceid-temperature',
            name: 'Temperature',
            device_class: 'temperature',
            unit_of_measurement: '°C',
            state_class: 'measurement',
            suggested_display_precision: 0,
            entity_category: 'diagnostic', // reads like an internal sensor - see the header
        })
        this.addField(config, {
            id: 0x1fd,
            name: '',
            comp: 'temperature',
            writable: false,
            read_xform: (raw) => raw / 2,
        })

        // Filter life. The appliance reports the hours left and the hour budget as separate tags;
        // what is worth an entity is the percentage, so both tags feed one computed value.
        this.addFilterLife(config, 'filter_life', 'Filter life', TAG_FILTER_REMAIN, TAG_FILTER_MAX)
        this.addFilterLife(config, 'top_filter_life', 'Top filter life', TAG_TOP_FILTER_REMAIN, TAG_TOP_FILTER_MAX)

        // 청정표시등 - the air-quality indicator lamp. The unit turns it on with itself; writing 0
        // while running switches it off and the change is reported back, so this is a real control.
        this.addSwitch(config, 'light', TAG_LIGHT, 'Clean indicator light', 'mdi:lightbulb')

        // 공기제균. The unit had this on out of the box; toggling it is confirmed both ways.
        this.addSwitch(config, 'sterilization', TAG_STERILIZE, 'Air sterilization', 'mdi:shield-sun')

        // Sleep timer, in minutes, counting down while it runs. Writing it while the unit is off is
        // ignored the same way a mode write is (quirk 1) - it is a setting for a running unit.
        config.components['sleep_timer'] = allowExtendedType({
            platform: 'number',
            unique_id: '$deviceid-sleep_timer',
            name: 'Sleep timer',
            icon: 'mdi:sleep',
            device_class: 'duration',
            unit_of_measurement: 'min',
            min: 0,
            max: 720,
            step: 10,
            mode: 'box',
        })
        this.addField(config, { id: TAG_SLEEP_TIMER, name: '', comp: 'sleep_timer' })

        config.components['error'] = allowExtendedType({
            platform: 'sensor',
            unique_id: '$deviceid-error',
            name: 'Error code',
            icon: 'mdi:alert',
            entity_category: 'diagnostic',
        })
        this.addField(config, { id: 0x221, name: '', comp: 'error', writable: false })

        this.setConfig(config)
    }

    // A writable on/off switch bound to a single 0/1 tag.
    private addSwitch(config: DeviceDiscovery, comp: string, id: number, name: string, icon: string) {
        config.components[comp] = allowExtendedType({
            platform: 'switch',
            unique_id: `$deviceid-${comp}`,
            name,
            icon,
            entity_category: 'config',
        })
        this.addField(config, {
            id,
            name: '',
            comp,
            read_xform: (raw) => (raw ? 'ON' : 'OFF'),
            write_xform: (val) => (val === 'ON' ? 1 : 0),
        })
    }

    private addParticulate(config: DeviceDiscovery, comp: string, id: number, name: string, deviceClass: string) {
        config.components[comp] = allowExtendedType({
            platform: 'sensor',
            unique_id: `$deviceid-${comp}`,
            name,
            device_class: deviceClass,
            unit_of_measurement: 'µg/m³',
            state_class: 'measurement',
        })
        this.addField(config, { id, name: '', comp, writable: false })
    }

    // A plain numeric readout with no device class - the unit's own index, not a physical quantity.
    private addReadout(config: DeviceDiscovery, comp: string, id: number, name: string, icon: string) {
        config.components[comp] = allowExtendedType({
            platform: 'sensor',
            unique_id: `$deviceid-${comp}`,
            name,
            icon,
            state_class: 'measurement',
        })
        this.addField(config, { id, name: '', comp, writable: false })
    }

    /*
     * One percentage out of a (remaining, budget) pair of hour counters. Both tags recompute it,
     * because either can arrive first and the budget is only resent with a full values response.
     *
     * Despite the cloud calling the first tag "useTime", it counts the hours *left*, not the hours
     * used: 3716 of 4000 and 3677 of 4000 are what the app was showing as 93 % and 92 % at the same
     * moment. Taking the name at face value would have reported this filter as nearly spent.
     */
    private addFilterLife(config: DeviceDiscovery, comp: string, name: string, remainTag: number, maxTag: number) {
        config.components[comp] = allowExtendedType({
            platform: 'sensor',
            unique_id: `$deviceid-${comp}`,
            name,
            icon: 'mdi:air-filter',
            unit_of_measurement: '%',
            state_class: 'measurement',
        })

        const recompute = () => {
            this.publishFilterLife(comp, remainTag, maxTag)
            return false // never publish the raw hour count to the percentage topic
        }

        // The first registers the state topic; the second only needs to trigger the recompute.
        this.addField(config, { id: remainTag, name: '', comp, writable: false, read_callback: recompute })
        this.addField(config, { id: maxTag, name: 'max', comp, writable: false, read_callback: recompute }, false)
    }

    private publishFilterLife(comp: string, remainTag: number, maxTag: number) {
        const remain = this.raw_clip_state[remainTag]
        const max = this.raw_clip_state[maxTag]
        if (remain === undefined || max === undefined || max <= 0) return

        const percent = Math.max(0, Math.min(100, Math.round((remain / max) * 100)))
        this.HA.publishProperty(this.id, `${comp}-`, percent)
    }

    processData(buf: Buffer) {
        if (buf[6] === 0xa7) {
            const b = Buffer.from(buf)
            b[6] = 0x87
            super.processData(b)
            return
        }
        super.processData(buf)
    }

    isCapsResponse(tlvArray: TLV.TLV[]) {
        return tlvArray.some(({ t }) => t === 0x2da)
    }

    isValuesResponse(tlvArray: TLV.TLV[]) {
        return tlvArray.length >= 10 && tlvArray.some(({ t }) => t === TAG_POWER)
    }
}
