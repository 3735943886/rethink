import TLVDevice from './tlv_device'
import { Device as Thinq2Device } from '../thinq2/device'
import { DeviceDiscovery, HumidifierComponent, type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import * as TLV from '@/util/tlv'
import HADevice from './base'

// LG dehumidifier, ThinQ model DHUM_056905_WW, deviceType 403.
//
// Same DualCool TLV protocol family as RAC / POT / WIN (the _056905_WW modem). The tag map
// below was reverse-engineered against the real appliance and cross-checked against the LG
// cloud's own decoded property names:
//
//   wire   cloud property                          HA entity
//   0x1f7  airState.operation                      humidifier power (ON/OFF)
//   0x1f9  airState.opMode                         humidifier mode
//          {17 smart, 18 jet, 19 silent, 20 spot, 21 laundry}
//   0x1fa  airState.windStrength {2 low, 6 high}   fan-speed select
//   0x253  airState.humidity.desired               humidifier target humidity (%)
//   0x336  airState.humidity.current               humidifier current humidity (%)
//   0x1fd  airState.tempState.current (raw/2 °C)   temperature sensor
//   0x21b  airState.reservation.targetTimeToStop   turn-off timer (minutes)
//   0x21e  airState.miscFuncState.watertankLight   water-tank light switch ("라이팅")
//   0x2a2  airState.miscFuncState.Uvnano           uvnano UV switch
//   0x221  airState.diagCode                       error-code sensor
//
// Quirks handled:
//
// 1. Wire header: like POT/CST, the async/query TLV frames use UART header byte6 = 0xa7
//    instead of 0x87. The base framing check only accepts 0x87, so processData normalizes a
//    copy of the buffer (never the original) before delegating.
//
// 2. The HA `humidifier` platform has no fan concept, so wind strength (약/강 only) is a
//    separate select. A fan change is reported on 0x1fa alongside the resent mode caps table.
//
// 3. Selecting a mode while powered off is ignored by the unit (same as RAC/CST); the mode
//    write forces 0x1f7=1 and attaches it, so picking a mode from off turns the unit on
//    directly in that mode.
//
// 4. There is no tank-full status property — confirmed against the LG cloud model and the
//    official LG integration, where tank-full is a push notification only. It surfaces via the
//    error/diagCode sensor when the unit halts.
//
// TODO: expose accumulated energy. The device reports no instantaneous power (no 0x2b3, no
// cloud energy property); a cumulative counter lives in the packed a8/67 monitoring frame
// (increments while running, freezes when off) — it needs that frame parsed and its unit
// calibrated against the app's displayed kWh.

const MODES = ['smart', 'jet', 'silent', 'spot', 'laundry']
const MODE_R: (string | undefined)[] = []
MODE_R[17] = 'smart'
MODE_R[18] = 'jet'
MODE_R[19] = 'silent'
MODE_R[20] = 'spot'
MODE_R[21] = 'laundry'
const MODE_W: Record<string, number> = { smart: 17, jet: 18, silent: 19, spot: 20, laundry: 21 }

const FAN_R: Record<number, string> = { 2: 'low', 6: 'high' }
const FAN_W: Record<string, number> = { low: 2, high: 6 }

export default class Device extends TLVDevice {
    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq)

        // NB: the friendly name goes in device.name — a top-level `name` key is rejected by
        // HA's device-based discovery schema ("extra keys not allowed @ data['name']").
        const config: DeviceDiscovery = allowExtendedType({
            ...HADevice.config(meta, { name: 'LG Dehumidifier' }),
            components: {
                humidifier: {
                    platform: 'humidifier',
                    unique_id: '$deviceid-humidifier',
                    name: null,
                    device_class: 'dehumidifier',
                    min_humidity: 40,
                    max_humidity: 70,
                    modes: MODES,
                } as HumidifierComponent,
            },
        })

        // Power — the humidifier's main ON/OFF (command_topic/state_topic, payload ON/OFF).
        this.addField(config, {
            id: 0x1f7,
            name: '',
            comp: 'humidifier',
            read_xform: (raw) => (raw ? 'ON' : 'OFF'),
            write_xform: (val) => (val === 'ON' ? 1 : 0),
            // when turning on, restore mode/fan/target in the same frame
            write_attach: (raw) => (raw ? [0x1f9, 0x1fa, 0x253] : []),
        })

        // Target humidity (%) -> target_humidity_command_topic / target_humidity_state_topic.
        this.addField(config, {
            id: 0x253,
            name: 'target_humidity',
            comp: 'humidifier',
            write_attach: [0x1f9, 0x1fa],
        })

        // Current humidity (%) -> current_humidity_topic. A direct percentage (no scaling).
        this.addField(config, {
            id: 0x336,
            name: 'current_humidity',
            comp: 'humidifier',
            state_topic: 'topic',
            writable: false,
        })

        // Operation mode -> mode_command_topic / mode_state_topic.
        this.addField(config, {
            id: 0x1f9,
            name: 'mode',
            comp: 'humidifier',
            read_xform: (raw) => MODE_R[raw],
            write_xform: (val) => {
                // setting the mode alone is ignored while off — force power on (quirk 3)
                this.raw_clip_state[0x1f7] = 1
                return MODE_W[val]
            },
            write_attach: [0x1f7, 0x1fa, 0x253],
        })

        // Fan speed — separate select (the humidifier platform has no fan concept).
        config.components['fan'] = allowExtendedType({
            platform: 'select',
            unique_id: '$deviceid-fan',
            name: 'Fan speed',
            icon: 'mdi:fan',
            options: ['low', 'high'],
        })
        this.addField(config, {
            id: 0x1fa,
            name: '',
            comp: 'fan',
            read_xform: (raw) => FAN_R[raw],
            write_xform: (val) => FAN_W[val],
            write_attach: [0x1f9, 0x253],
        })

        // Temperature sensor (raw/2 °C). Not shown in the app but present in the cloud model.
        config.components['temperature'] = allowExtendedType({
            platform: 'sensor',
            unique_id: '$deviceid-temperature',
            name: 'Temperature',
            device_class: 'temperature',
            unit_of_measurement: '°C',
            state_class: 'measurement',
            suggested_display_precision: 0,
        })
        this.addField(config, {
            id: 0x1fd,
            name: '',
            comp: 'temperature',
            writable: false,
            read_xform: (raw) => raw / 2,
        })

        // Turn-off timer (0x21b, minutes) — the app offers 1..8 h. Same tag/scale as RAC's
        // stoptimer: the unit counts down and reports the remaining minutes as it goes.
        config.components['stoptimer'] = allowExtendedType({
            platform: 'number',
            unique_id: '$deviceid-stoptimer',
            name: 'Turn-off timer',
            icon: 'mdi:timer-stop',
            device_class: 'duration',
            unit_of_measurement: 'h',
            min: 0,
            max: 8,
            step: 1,
            mode: 'slider',
        })
        this.addField(config, {
            id: 0x21b,
            name: '',
            comp: 'stoptimer',
            read_xform: (raw) => Math.round(raw / 60),
            write_xform: (val) => Math.round(Number(val) * 60),
        })

        // Water-tank light ("라이팅") switch.
        this.addSwitch(config, 'light', 0x21e, 'Lighting', 'mdi:lightbulb')

        // uvnano UV sterilization switch.
        this.addSwitch(config, 'uvnano', 0x2a2, 'uvnano', 'mdi:water-check')

        // Error code (0x221 diagCode) — water-tank-full and other faults surface here.
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
    addSwitch(config: DeviceDiscovery, comp: string, id: number, name: string, icon: string) {
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
        return tlvArray.length >= 10 && tlvArray.some(({ t }) => t === 0x1f7)
    }
}
