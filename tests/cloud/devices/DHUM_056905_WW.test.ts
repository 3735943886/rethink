import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/DHUM_056905_WW'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf } from '@/tests/helpers/mocks'
import { enableMockTimers } from '@/tests/helpers/timers'
import * as TLV from '@/util/tlv'

const DEVICE_ID = 'test-id'
const MODEL_ID = 'DHUM_056905_WW'
const META: Metadata = { modelId: MODEL_ID, modelName: 'DHUM_056905_WW', swVersion: '1.0' }

// Real packet captures from a DHUM_056905_WW dehumidifier. Every frame keeps its UART header
// byte6 = 0xA7 (the async/query marker this family uses instead of 0x87), so the tests exercise
// the handler's header normalization end to end. Ground-truth tag per frame is noted inline.
const F_POWER_ON = '000004000000a70204d8027dc17b82' //   0x1f7 = 1     power ON
const F_POWER_OFF = '000004000000a70204a4027dc066e4' //  0x1f7 = 0     power OFF
const F_MODE_SMART = '000004000000a70204ec037e5011ce3a' // 0x1f9 = 17   mode smart
const F_MODE_JET = '00000400000087020423037e5012a818' //  0x1f9 = 18   mode jet (0x87 form)
const F_TARGET_50 = '000004000000a70204fe0394d032e68a' //  0x253 = 50   target humidity 50 %
const F_HUMIDITY_52 = '000004000000a70204b203cd9034d19c' // 0x336 = 52  current humidity 52 %
const F_TEMP_58 = '000004000000a70204e7037f503a80fc' //     0x1fd = 58   temperature 29 C (raw/2)
// Mode-caps table resent on a fan change: five 0x2d7/0x2d8/0x2d9 rows, all with 0x2d9 = 6 (high).
const F_FANTABLE_HIGH =
    '000004000000a70204e9287e50147e86b5d011b600b646b5d012b600b646b5d014b600b646b5d015b600b646b5d016b600b6462b2a'
// Same table but 0x2d9 = 2 (low) — a pure fan-only change carries no standalone 0x1fa.
const F_FANTABLE_LOW =
    '000004000000a702043c257e82b5d011b600b642b5d012b600b642b5d014b600b642b5d015b600b642b5d016b600b64297e8'

function build(t: import('node:test').TestContext) {
    enableMockTimers(t)
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    ha.on('setProperty', (_id: string, prop: string, value: string) => dev.setProperty(prop, value))
    thinq.resetRecorder() // discard the queryCaps packet the constructor sent
    return { ha, thinq, dev }
}

/** TLVs of a packet the handler put on the wire (header [1,1,2,1,1] + TLV body + CRC). */
function sentTLVs(pkt: Buffer): Record<number, number> {
    const out: Record<number, number> = {}
    for (const { t, v } of TLV.parse(pkt.subarray(11, pkt.length - 2))) out[t] = v
    return out
}

describe(MODEL_ID, () => {
    test('config exposes the humidifier + auxiliary components', (t) => {
        const { ha, dev } = build(t)
        const cfg = ha.devices[DEVICE_ID].config! as Record<string, unknown>
        // HA device-based discovery rejects a top-level `name`; it must live in device.name.
        assert.equal(cfg.name, undefined, 'no top-level name key')
        assert.equal((cfg.device as { name?: string }).name, 'LG Dehumidifier')
        const c = ha.devices[DEVICE_ID].config!.components as Record<string, Record<string, unknown>>

        assert.equal(c.humidifier.platform, 'humidifier')
        assert.equal(c.humidifier.device_class, 'dehumidifier')
        assert.equal(c.humidifier.min_humidity, 40)
        assert.equal(c.humidifier.max_humidity, 70)
        assert.deepEqual(c.humidifier.modes, ['smart', 'jet', 'silent', 'spot', 'laundry'])
        // humidifier attribute topics wired up by addField
        assert.ok(c.humidifier.command_topic, 'power command topic')
        assert.ok(c.humidifier.target_humidity_command_topic, 'target humidity command topic')
        assert.ok(c.humidifier.current_humidity_topic, 'current humidity topic')
        assert.ok(c.humidifier.mode_command_topic, 'mode command topic')

        assert.equal(c.fan.platform, 'select')
        assert.deepEqual(c.fan.options, ['low', 'high'])
        assert.equal(c.temperature.platform, 'sensor')
        assert.equal(c.temperature.device_class, 'temperature')
        assert.equal(c.stoptimer.platform, 'number')
        assert.equal(c.light.platform, 'switch')
        assert.equal(c.uvnano.platform, 'switch')
        assert.equal(c.error.platform, 'sensor')

        dev.drop()
    })

    test('0xA7 async frames decode and publish state', (t) => {
        const { ha, thinq, dev } = build(t)
        // F_FANTABLE_HIGH also reports mode=spot, so apply F_MODE_SMART after it.
        for (const f of [F_POWER_ON, F_FANTABLE_HIGH, F_MODE_SMART, F_TARGET_50, F_HUMIDITY_52, F_TEMP_58]) {
            thinq.emit('data', buf(f))
        }
        const p = ha.devices[DEVICE_ID].properties
        assert.equal(p['humidifier-'], 'ON') // power
        assert.equal(p['humidifier-mode'], 'smart')
        assert.equal(p['humidifier-target_humidity'], 50)
        assert.equal(p['humidifier-current_humidity'], 52)
        assert.equal(p['temperature-'], 29) // 58 / 2
        assert.equal(p['fan-'], 'high') // 0x1fa = 6

        dev.drop()
    })

    test('a fan change is reported on 0x1fa within the resent mode table', (t) => {
        const { ha, thinq, dev } = build(t)
        thinq.emit('data', buf(F_FANTABLE_LOW)) // carries 0x1fa = 2
        assert.equal(ha.devices[DEVICE_ID].properties['fan-'], 'low')

        dev.drop()
    })

    /*
     * The target-humidity entity had a state topic, a command topic and a working read, and every
     * one of those was covered here - but nothing checked that a write left the handler, and it did
     * not: the field has no write_xform, which used to make the base drop the write in silence.
     * Verified against the physical dehumidifier, which answered a 0x253 = 55 write with
     * airState.humidity.desired = 55.
     */
    test('setting the target humidity actually reaches the wire', (t) => {
        const { thinq, dev } = build(t)
        thinq.emit('data', buf(F_FANTABLE_HIGH)) // seed fan (0x1fa)
        thinq.emit('data', buf(F_MODE_SMART)) // seed mode (0x1f9)
        thinq.emit('data', buf(F_POWER_ON))
        thinq.resetRecorder()

        dev.setProperty('humidifier-target_humidity', '55')

        assert.equal(thinq.outbox.length, 1, 'one write frame')
        const tlv = sentTLVs(thinq.outbox[0])
        assert.equal(tlv[0x253], 55, 'target humidity on the wire')
        assert.equal(tlv[0x1f9], 17, 'mode attached')
        assert.equal(tlv[0x1fa], 6, 'fan attached')

        dev.drop()
    })

    test('selecting a mode from off turns the unit on in one frame', (t) => {
        const { thinq, dev } = build(t)
        // seed fan (0x1fa) + target (0x253) so the attached tags carry real values
        thinq.emit('data', buf(F_FANTABLE_HIGH))
        thinq.emit('data', buf(F_TARGET_50))
        thinq.emit('data', buf(F_POWER_OFF))
        thinq.resetRecorder()

        dev.setProperty('humidifier-mode', 'jet')

        assert.equal(thinq.outbox.length, 1, 'one write frame')
        const tlv = sentTLVs(thinq.outbox[0])
        assert.equal(tlv[0x1f9], 18, 'mode = jet')
        assert.equal(tlv[0x1f7], 1, 'power forced on in the same frame')

        dev.drop()
    })

    test('power write maps ON/OFF to 0x1f7', (t) => {
        const { thinq, dev } = build(t)
        thinq.emit('data', buf(F_POWER_OFF))
        thinq.resetRecorder()

        dev.setProperty('humidifier-', 'ON')
        assert.equal(sentTLVs(thinq.outbox[0])[0x1f7], 1)

        thinq.resetRecorder()
        dev.setProperty('humidifier-', 'OFF')
        assert.equal(sentTLVs(thinq.outbox[0])[0x1f7], 0)

        dev.drop()
    })

    test('light and uvnano switches map to their tags', (t) => {
        const { thinq, dev } = build(t)
        dev.setProperty('light-', 'ON')
        assert.equal(sentTLVs(thinq.outbox[0])[0x21e], 1)
        thinq.resetRecorder()
        dev.setProperty('uvnano-', 'ON')
        assert.equal(sentTLVs(thinq.outbox[0])[0x2a2], 1)

        dev.drop()
    })
})
