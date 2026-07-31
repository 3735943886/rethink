import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/AIR_910604_WW'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf } from '@/tests/helpers/mocks'
import { enableMockTimers } from '@/tests/helpers/timers'
import * as TLV from '@/util/tlv'

const DEVICE_ID = 'test-id'
const MODEL_ID = 'AIR_910604_WW'
const META: Metadata = { modelId: MODEL_ID, modelName: 'AIR_910604_WW', swVersion: '1.0' }

// Real captures from an AIR_910604_WW air purifier, taken while driving the appliance over the
// management interface. Every frame keeps its UART header byte6 = 0xA7, the marker this family
// uses instead of 0x87, so the tests exercise the handler's header normalization end to end.

// Full values response (reply to a 0x1f5=2 query) with the unit idle: power off, mode auto (16),
// wind strength auto (8), PM1/PM2.5/PM10 all 8, humidity 30 %, temperature raw 80, filter counters
// 3716/4000 and 3677/4000.
const F_VALUES =
    '000004000000a7020486647dc07e50107e887f007f807f5050868086c087008980d7c0d801d840d88087809380cd48cd08c' +
    'cc890419001cd901e8840d5600e84d5a00fa0d8e00e5dd9200fa0ce80ab00c988c9c0ca00b5d010b600b648b5cdb600b648' +
    'b5cfb600b648b5ceb60eb64e2357'

// Capability response (reply to 0x1f5=1). 0x2c1 = 0x1E000 selects modes 13..16, 0x2c2 = 468 selects
// wind strengths 2/4/6/7/8.
const F_CAPS =
    '000004000000a702013b50b00cb07001e000b0a001d4b3200800b340b4d080b584b540b6a032f8b6e02115b700b7509fbc5' +
    '0c1b3c0b42001d4b441bd206004bd501fb5d010b600b648b5cdb600b648b5cfb600b648b5ceb600b6484ee8'

// The unsolicited single-tag frame the unit emits every few seconds: 0x335 (PM10) = 9.
const F_PM10_9 = '000004000000a702042502cd49d3c4'
// What the unit reported back after a power-on command: 0x1f7 = 1 and 0x24e (panel light) = 1.
const F_POWER_ON = '000004000000a7020455047dc19381fe9e'
// ...and after power-off: both back to 0.
const F_POWER_OFF = '000004000000a7020485047dc093807d3b'
// After a mode command: 0x1f9 = 15 (dual_clean).
const F_MODE_DUAL = '000004000000a7020478027e4fb4e1'
// After a fan command: 0x1fa = 2 (low), followed by the remembered-per-mode 0x2d7/0x2d8/0x2d9 rows
// the unit always resends with a fan change.
const F_FAN_LOW = '000004000000a702047b147e82b5cdb600b642b5cfb600b642b5ceb60eb64e5078'
// The same 0x1f9 = 15 report, but with the plain 0x87 header, to prove both are accepted.
const F_MODE_DUAL_87 = '00000400000087020478027e4fb4e1'
// Answer to a sleep-timer command: 0x21a = 60 minutes, and the unit switched 청정표시등 off by
// itself in the same frame (0x24e = 0).
const F_SLEEP_60 = '000004000000a70204a40586903c9380f79a'
// A minute later - the timer counts down rather than holding what was asked for.
const F_SLEEP_59 = '000004000000a70204a80386903b8fdb'
// 480 minutes accepted, past the 420 the model description declares as the maximum.
const F_SLEEP_480 = '000004000000a70204a90486a001e04bc6'
// Sleep timer cleared, and 청정표시등 back on.
const F_SLEEP_0_LIGHT_ON = '000004000000a70204aa048680938101ee'
// 공기제균 (0x360) toggled off, then back on.
const F_STERILIZE_OFF = '000004000000a70204a602d800b04b'
const F_STERILIZE_ON = '000004000000a70204ab02d80199ec'

function build(t: import('node:test').TestContext) {
    enableMockTimers(t)
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    ha.on('setProperty', (_id: string, prop: string, value: string) => dev.setProperty(prop, value))
    thinq.resetRecorder() // discard the queryCaps packet the constructor sent
    return { ha, thinq, dev }
}

/** TLVs of a packet the handler put on the wire (header + TLV body + CRC). */
function sentTLVs(pkt: Buffer): Record<number, number> {
    const out: Record<number, number> = {}
    for (const { t, v } of TLV.parse(pkt.subarray(11, pkt.length - 2))) out[t] = v
    return out
}

const props = (ha: MockHAConnection) => ha.devices[DEVICE_ID].properties

describe(MODEL_ID, () => {
    test('config exposes a fan, a mode select and the sensors', (t) => {
        const { ha } = build(t)
        const cfg = ha.devices[DEVICE_ID].config! as Record<string, unknown>
        // HA device-based discovery rejects a top-level `name`; it must live in device.name.
        assert.equal(cfg.name, undefined, 'no top-level name key')
        assert.equal((cfg.device as { name?: string }).name, 'LG Air Purifier')

        const c = ha.devices[DEVICE_ID].config!.components as Record<string, Record<string, unknown>>
        assert.equal(c.fan.platform, 'fan')
        assert.deepEqual(c.fan.preset_modes, ['low', 'mid', 'high', 'power', 'auto'])
        assert.ok(c.fan.command_topic, 'power command topic')
        assert.ok(c.fan.preset_mode_command_topic, 'preset mode command topic')

        assert.equal(c.mode.platform, 'select')
        assert.deepEqual(c.mode.options, ['circulator_clean', 'baby_care', 'dual_clean', 'auto'])

        assert.equal(c.pm1.device_class, 'pm1')
        assert.equal(c.pm25.device_class, 'pm25')
        assert.equal(c.pm10.device_class, 'pm10')
        // the unit's temperature and humidity tags do not describe the room - see the header
        assert.equal(c.humidity, undefined)
        assert.equal(c.temperature, undefined)
        assert.equal(c.filter_life.unit_of_measurement, '%')
        assert.equal(c.top_filter_life.unit_of_measurement, '%')
    })

    test('values response decodes the whole state', (t) => {
        const { ha, thinq } = build(t)
        thinq.emit('data', buf(F_VALUES))

        const p = props(ha)
        assert.equal(p['fan-'], 'OFF')
        assert.equal(p['mode-'], 'auto')
        assert.equal(p['fan-preset_mode'], 'auto')
        assert.equal(p['pm1-'], 8)
        assert.equal(p['pm25-'], 8)
        assert.equal(p['pm10-'], 8)
        // the frame carries humidity 30 and temperature raw 80, and neither is published
        assert.equal(p['humidity-'], undefined)
        assert.equal(p['temperature-'], undefined)
        assert.equal(p['air_quality-'], 1)
        assert.equal(p['odor-'], 1)
        assert.equal(p['light-'], 'OFF')
        assert.equal(p['sterilization-'], 'ON') // the unit ships with 공기제균 on
        assert.equal(p['sleep_timer-'], 0)
        assert.equal(p['error-'], 0)
    })

    test('filter life is a percentage computed from the remaining/budget pair', (t) => {
        const { ha, thinq } = build(t)
        thinq.emit('data', buf(F_VALUES))

        // The tag the cloud calls "useTime" is the hours *left*, not the hours used - the app was
        // showing 93 % and 92 % for these two counters at the moment this frame was captured.
        assert.equal(props(ha)['filter_life-'], 93) // 3716 of 4000
        assert.equal(props(ha)['top_filter_life-'], 92) // 3677 of 4000
        // the raw hour counts never reach the percentage topic
        assert.notEqual(props(ha)['filter_life-'], 3716)
    })

    test('the unsolicited PM10 frame updates only PM10', (t) => {
        const { ha, thinq } = build(t)
        thinq.emit('data', buf(F_VALUES))
        thinq.emit('data', buf(F_PM10_9))

        assert.equal(props(ha)['pm10-'], 9)
        assert.equal(props(ha)['pm1-'], 8, 'PM1 untouched')
        assert.equal(props(ha)['pm25-'], 8, 'PM2.5 untouched')
    })

    test('power, mode and fan reports from the appliance', (t) => {
        const { ha, thinq } = build(t)
        thinq.emit('data', buf(F_VALUES))

        thinq.emit('data', buf(F_POWER_ON))
        assert.equal(props(ha)['fan-'], 'ON')
        assert.equal(props(ha)['light-'], 'ON')

        thinq.emit('data', buf(F_MODE_DUAL))
        assert.equal(props(ha)['mode-'], 'dual_clean')

        thinq.emit('data', buf(F_FAN_LOW))
        assert.equal(props(ha)['fan-preset_mode'], 'low')

        thinq.emit('data', buf(F_POWER_OFF))
        assert.equal(props(ha)['fan-'], 'OFF')
        assert.equal(props(ha)['light-'], 'OFF')
    })

    test('a frame with the plain 0x87 header is accepted too', (t) => {
        const { ha, thinq } = build(t)
        thinq.emit('data', buf(F_MODE_DUAL_87))
        assert.equal(props(ha)['mode-'], 'dual_clean')
    })

    test('turning the fan on resends the mode and speed in the same frame', (t) => {
        const { ha, thinq } = build(t)
        thinq.emit('data', buf(F_VALUES))
        thinq.resetRecorder()

        ha.emit('setProperty', DEVICE_ID, 'fan-', 'ON')
        assert.equal(thinq.outbox.length, 1)
        assert.deepEqual(sentTLVs(thinq.outbox[0]), { 0x1f7: 1, 0x1f9: 16, 0x1fa: 8 })
    })

    test('turning the fan off sends the power tag alone', (t) => {
        const { ha, thinq } = build(t)
        thinq.emit('data', buf(F_VALUES))
        thinq.resetRecorder()

        ha.emit('setProperty', DEVICE_ID, 'fan-', 'OFF')
        assert.deepEqual(sentTLVs(thinq.outbox[0]), { 0x1f7: 0 })
    })

    test('selecting a mode while off forces the power tag on, so the unit starts in that mode', (t) => {
        const { ha, thinq } = build(t)
        thinq.emit('data', buf(F_VALUES)) // leaves the unit off
        thinq.resetRecorder()

        ha.emit('setProperty', DEVICE_ID, 'mode-', 'dual_clean')
        // a bare mode write is acknowledged and ignored by the appliance - see quirk 1
        assert.deepEqual(sentTLVs(thinq.outbox[0]), { 0x1f9: 15, 0x1f7: 1, 0x1fa: 8 })
    })

    test('picking a fan speed likewise carries the power and mode tags', (t) => {
        const { ha, thinq } = build(t)
        thinq.emit('data', buf(F_VALUES))
        thinq.resetRecorder()

        ha.emit('setProperty', DEVICE_ID, 'fan-preset_mode', 'high')
        assert.deepEqual(sentTLVs(thinq.outbox[0]), { 0x1fa: 6, 0x1f7: 1, 0x1f9: 16 })
    })

    test('sleep timer reports the live countdown, not what was asked for', (t) => {
        const { ha, thinq } = build(t)
        thinq.emit('data', buf(F_VALUES))

        thinq.emit('data', buf(F_SLEEP_60))
        assert.equal(props(ha)['sleep_timer-'], 60)
        // the appliance turns 청정표시등 off along with a sleep setting, in the same frame
        assert.equal(props(ha)['light-'], 'OFF')

        thinq.emit('data', buf(F_SLEEP_59))
        assert.equal(props(ha)['sleep_timer-'], 59)

        thinq.emit('data', buf(F_SLEEP_480))
        assert.equal(props(ha)['sleep_timer-'], 480)

        thinq.emit('data', buf(F_SLEEP_0_LIGHT_ON))
        assert.equal(props(ha)['sleep_timer-'], 0)
        assert.equal(props(ha)['light-'], 'ON')
    })

    test('the sleep timer entity spans the full range the appliance accepts', (t) => {
        const { ha } = build(t)
        const c = ha.devices[DEVICE_ID].config!.components as Record<string, Record<string, unknown>>
        assert.equal(c.sleep_timer.platform, 'number')
        assert.equal(c.sleep_timer.min, 0)
        assert.equal(c.sleep_timer.max, 720) // 480 was verified accepted; the model's 420 is not a limit
        assert.equal(c.sleep_timer.unit_of_measurement, 'min')
    })

    test('writing the sleep timer sends the minute count as-is', (t) => {
        const { ha, thinq } = build(t)
        thinq.emit('data', buf(F_VALUES))
        thinq.resetRecorder()

        ha.emit('setProperty', DEVICE_ID, 'sleep_timer-', '120')
        assert.deepEqual(sentTLVs(thinq.outbox[0]), { 0x21a: 120 })
    })

    test('공기제균 reads and writes on its own tag', (t) => {
        const { ha, thinq } = build(t)
        thinq.emit('data', buf(F_VALUES))

        thinq.emit('data', buf(F_STERILIZE_OFF))
        assert.equal(props(ha)['sterilization-'], 'OFF')
        thinq.emit('data', buf(F_STERILIZE_ON))
        assert.equal(props(ha)['sterilization-'], 'ON')

        thinq.resetRecorder()
        ha.emit('setProperty', DEVICE_ID, 'sterilization-', 'OFF')
        assert.deepEqual(sentTLVs(thinq.outbox[0]), { 0x360: 0 })
        ha.emit('setProperty', DEVICE_ID, 'sterilization-', 'ON')
        assert.deepEqual(sentTLVs(thinq.outbox[1]), { 0x360: 1 })
    })

    test('청정표시등 writes on its own tag', (t) => {
        const { ha, thinq } = build(t)
        thinq.emit('data', buf(F_VALUES))
        thinq.resetRecorder()

        ha.emit('setProperty', DEVICE_ID, 'light-', 'OFF')
        assert.deepEqual(sentTLVs(thinq.outbox[0]), { 0x24e: 0 })
    })

    test('the capability response is recognized and does not disturb the state', (t) => {
        const { ha, thinq, dev } = build(t)
        thinq.emit('data', buf(F_VALUES))
        const before = { ...props(ha) }

        thinq.emit('data', buf(F_CAPS))
        assert.ok(dev.isCapsResponse(TLV.parse(buf(F_CAPS).subarray(11, buf(F_CAPS).length - 2))))
        assert.equal(props(ha)['mode-'], before['mode-'])
        assert.equal(props(ha)['fan-preset_mode'], before['fan-preset_mode'])
    })

    test('a values response is told apart from a capability one', (t) => {
        const { dev } = build(t)
        const tlvsOf = (h: string) => TLV.parse(buf(h).subarray(11, buf(h).length - 2))

        assert.ok(dev.isValuesResponse(tlvsOf(F_VALUES)))
        assert.ok(!dev.isValuesResponse(tlvsOf(F_CAPS)))
        assert.ok(!dev.isCapsResponse(tlvsOf(F_VALUES)))
        // a single-tag async report is neither
        assert.ok(!dev.isValuesResponse(tlvsOf(F_PM10_9)))
        assert.ok(!dev.isCapsResponse(tlvsOf(F_PM10_9)))
    })
})
