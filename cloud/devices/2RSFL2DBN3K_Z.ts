import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { DeviceDiscovery, type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import AABBDevice from './aabb_device'
import {
    convertFreezerTemperature,
    convertFridgeTemperature,
    freezerRange,
    fridgeRange,
    TemperatureUnit,
} from './fridge_common'

/*
 * F017 set-command frame, captured verbatim from a live unit (all setting bytes blanked to FF).
 * Unlike the shorter 12/27-byte fridges, this model's write frame (120 bytes) doesn't match its own
 * read/status frame (95 bytes) byte-for-byte, and carries fixed non-FF markers at several offsets
 * that a plain packStatus() fill would lose - so the base is a literal capture, not a generic pack.
 */
const F017_BASE =
    'F017FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF000000FFFF00FFFFFFFF00FFFFFFFFFFFFFFFFFF00FFFFFF1EFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0AFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF00FFFFFFFFFFFFFFFFFFFFFFFFFFFFFF'

function buildF017Message(unit: TemperatureUnit): Buffer {
    const message = Buffer.from(F017_BASE, 'hex')
    message[2 + 8] = unit === 'C' ? 1 : 0
    return message
}

export default class Device extends AABBDevice {
    readonly deviceConfig: DeviceDiscovery
    temperatureUnit: TemperatureUnit | undefined

    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq)
        this.deviceConfig = HADevice.config(meta, { name: 'LG Fridge' })

        // HomeAssistant configuration will be ready once we find out the temperature unit
    }

    setTemperatureUnit(unit: TemperatureUnit) {
        if (this.temperatureUnit === unit) return

        this.temperatureUnit = unit
        // set or re-set the temperature unit
        this.setConfig(
            allowExtendedType({
                ...this.deviceConfig,
                components: {
                    fridge_setpoint: {
                        platform: 'number',
                        device_class: 'temperature',
                        unique_id: '$deviceid-fridge_setpoint',
                        state_topic: '$this/fridge_setpoint',
                        command_topic: '$this/fridge_setpoint/set',
                        name: 'Fridge temperature',
                        ...fridgeRange(unit),
                    },
                    freezer_setpoint: {
                        platform: 'number',
                        device_class: 'temperature',
                        unique_id: '$deviceid-freezer_setpoint',
                        state_topic: '$this/freezer_setpoint',
                        command_topic: '$this/freezer_setpoint/set',
                        name: 'Freezer temperature',
                        ...freezerRange(unit),
                    },
                    express_freeze: {
                        platform: 'switch',
                        unique_id: '$deviceid-express_freeze',
                        state_topic: '$this/express_freeze',
                        command_topic: '$this/express_freeze/set',
                        icon: 'mdi:snowflake',
                        name: 'Express Freeze',
                    },
                    door: {
                        platform: 'binary_sensor',
                        device_class: 'door',
                        unique_id: '$deviceid-door',
                        state_topic: '$this/door',
                        name: 'Door',
                    },
                },
            }),
        )
    }

    start() {
        this.send(Buffer.from('F0ED1211010000010400', 'hex'))
    }

    processAABB(buf: Buffer) {
        // I'm not sure what is the proper way to identify packet types, so let's match
        // on the length and a few initial bytes

        if (buf[0] == 0x10 && buf[1] == 0xec) {
            // 10EC (prev status) (cur status)
            const blockLen = (buf.length - 2) / 2
            this.processStatus(buf.subarray(2 + blockLen, 2 + blockLen + blockLen))
        }

        if (buf[0] == 0x10 && buf[1] == 0xeb) {
            // 10EB (initial status)
            const blockLen = buf.length - 2
            this.processStatus(buf.subarray(2, 2 + blockLen))
        }
    }

    processStatus(curStatus: Buffer) {
        // Verified against a live unit: [0]=monStatus [1]=fridgeSetpoint [2]=freezerSetpoint
        // [3]=expressFreeze (1=off 2=on) [8]=tempUnit (0=F 1=C). Fields beyond those match the
        // shared layout other 2RE*/2RS* fridges use (see fridge_common.ts), but weren't exercised
        // in the captures this driver is built from, so only the confirmed ones are read here.
        if (curStatus.length < 9) {
            console.warn(`Unexpected refrigerator status length: ${curStatus.length}`)
            return
        }

        const unit = curStatus[8] ? 'C' : 'F'
        this.setTemperatureUnit(unit)

        const anyDoorOpen = curStatus.length > 7 ? curStatus[7] : undefined
        if (anyDoorOpen !== undefined) this.publishProperty('door', anyDoorOpen === 1 ? 'ON' : 'OFF')
        this.publishProperty('fridge_setpoint', convertFridgeTemperature(this.temperatureUnit!, curStatus[1]))
        this.publishProperty('freezer_setpoint', convertFreezerTemperature(this.temperatureUnit!, curStatus[2]))
        this.publishProperty('express_freeze', curStatus[3] === 2 ? 'ON' : 'OFF')
    }

    setProperty(prop: string, mqttValue: string) {
        // We shouldn't receive any setProperty calls before the temperatureUnit is set. But let's be safe
        const unit = this.temperatureUnit || 'C'

        if (prop === 'fridge_setpoint') {
            const message = buildF017Message(unit)
            message[2 + 1] = convertFridgeTemperature(unit, Number(mqttValue))
            this.send(message)
        } else if (prop === 'freezer_setpoint') {
            const message = buildF017Message(unit)
            message[2 + 2] = convertFreezerTemperature(unit, Number(mqttValue))
            this.send(message)
        } else if (prop === 'express_freeze') {
            if (mqttValue !== 'ON' && mqttValue !== 'OFF') {
                console.warn(`Unexpected express freeze value ${mqttValue}`)
                return
            }
            const message = buildF017Message(unit)
            message[2 + 3] = mqttValue === 'ON' ? 2 : 1
            this.send(message)
        }
    }
}
