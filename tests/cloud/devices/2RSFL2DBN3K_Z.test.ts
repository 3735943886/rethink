import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/2RSFL2DBN3K_Z'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf, hex } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-id'
const MODEL_ID = '2RSFL2DBN3K_Z'
const META: Metadata = { modelId: MODEL_ID, modelName: MODEL_ID, swVersion: '1.0' }

// Real packet captures from a live 2RSFL2DBN3K_Z fridge.
// Status block is 95 bytes (unlike this fridge's own 120-byte F017 write frame):
//   AA 0x65 10 EB <95 bytes> <cksum> BB               - initial-status
//   AA 0xC4 10 EC <95 prev> <95 cur> <cksum> BB        - status delta (only `cur` used)
// fridge=2C (raw 6), freezer=-18C (raw 4), door closed, express freeze off, unit=C.
const SAMPLE_INITIAL = buf(
    'AA6510EB0206040102FFFF00010001FFFFFFFFFFFF00FFFFFFFFFFFFFFFF000000FF00FFFFFFFFFFFFFFFFFF01FF0000FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0078FFFFFFFFFFFFFFFFFFFFFFFF000000FFFFFFFF0005FFFFFFFF0C0100FF0036BB',
)

// Delta captured moments later: fridge setpoint moved from raw 6 (2C) to raw 5 (3C).
const SAMPLE_DELTA_FRIDGE_SETPOINT_CHANGE = buf(
    'AAC410EC0206040102FFFF00010001FFFFFFFFFFFF00FFFFFFFFFFFFFFFF020000FF00FFFFFFFFFFFFFFFFFF01FF0000FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0078FFFFFFFFFFFFFFFFFFFFFFFF000000FFFFFFFF0005FFFFFFFF640100FF000205040102FFFF00010001FFFFFFFFFFFF00FFFFFFFFFFFFFFFF020000FF00FFFFFFFFFFFFFFFFFF01FF0000FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0078FFFFFFFFFFFFFFFFFFFFFFFF000000FFFFFFFF0005FFFFFFFF640100FF009ABB',
)

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    return { ha, thinq, dev }
}

describe(MODEL_ID, () => {
    test('config not published until a status frame establishes the unit', () => {
        const { ha } = makeDevice()
        assert.equal(ha.devices[DEVICE_ID], undefined)
    })

    test('0x10EB initial status: publishes Celsius config and decodes setpoints', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_INITIAL)

        const dev = ha.devices[DEVICE_ID]
        assert.ok(dev?.config, 'config published')

        const components = dev.config!.components as Record<string, Record<string, unknown>>
        assert.equal(components.fridge_setpoint.unit_of_measurement, '°C')
        assert.equal(components.freezer_setpoint.unit_of_measurement, '°C')
        assert.ok(components.express_freeze, 'express_freeze component')
        assert.ok(components.door, 'door component')

        assert.equal(dev.properties.fridge_setpoint, 2) // 8 - 6
        assert.equal(dev.properties.freezer_setpoint, -18) // -14 - 4
        assert.equal(dev.properties.door, 'OFF')
        assert.equal(dev.properties.express_freeze, 'OFF')
    })

    test('0x10EC delta reflects a fridge setpoint change', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_DELTA_FRIDGE_SETPOINT_CHANGE)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.fridge_setpoint, 3) // 8 - 5
        assert.equal(props.door, 'OFF')
        assert.equal(props.express_freeze, 'OFF')
    })

    test('frames not matching the AA..BB envelope are ignored', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', buf('001122'))
        assert.equal(ha.devices[DEVICE_ID], undefined)
    })

    test('frames with unrecognised inner shape are ignored', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', buf('AA08109901020304BB'))
        assert.equal(ha.devices[DEVICE_ID], undefined)
    })

    test('start() sends the F0ED status-query packet on the wire', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()
        dev.start()
        assert.equal(thinq.outbox.length, 1)
        assert.equal(hex(thinq.outbox[0]), 'AA0EF0ED1211010000010400EBBB')
    })

    test('HA write fridge_setpoint=2C matches a real captured command byte-for-byte', () => {
        const { thinq, dev } = makeDevice()
        thinq.emit('data', SAMPLE_INITIAL) // unit becomes C
        thinq.resetRecorder()

        dev.setProperty('fridge_setpoint', '2')
        // Captured live: setting fridge to 2C (raw 6) produced this exact 124-byte frame.
        assert.equal(
            hex(thinq.outbox[0]),
            'AA7CF017FF06FFFFFFFFFFFF01FFFFFFFFFFFFFFFFFFFFFFFF000000FFFF00FFFFFFFF00FFFFFFFFFFFFFFFFFF00FFFFFF1EFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0AFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF00FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFA4BB',
        )
    })

    test('HA write freezer_setpoint=-20C sets the freezer field, fridge field untouched', () => {
        const { thinq, dev } = makeDevice()
        thinq.emit('data', SAMPLE_INITIAL)
        thinq.resetRecorder()

        dev.setProperty('freezer_setpoint', '-20')
        const pkt = thinq.outbox[0]
        assert.equal(pkt[4 + 2], 6) // freezerSetpoint: -14 - (-20) = 6
        assert.equal(pkt[4 + 1], 0xff) // fridgeSetpoint untouched
        assert.equal(pkt[4 + 8], 1) // unit = C
    })

    test('HA write express_freeze=ON matches the expressFreeze field of a real captured command', () => {
        const { thinq, dev } = makeDevice()
        thinq.emit('data', SAMPLE_INITIAL)
        thinq.resetRecorder()

        dev.setProperty('express_freeze', 'ON')
        const pkt = thinq.outbox[0]
        // Captured live express-freeze-ON command sets this same byte to 2.
        assert.equal(pkt[4 + 3], 2)
    })

    test('HA write express_freeze with an unexpected value sends nothing', () => {
        const { thinq, dev } = makeDevice()
        thinq.emit('data', SAMPLE_INITIAL)
        thinq.resetRecorder()

        dev.setProperty('express_freeze', 'MAYBE')
        assert.equal(thinq.outbox.length, 0)
    })

    test('HA write to an unknown property sends nothing', () => {
        const { thinq, dev } = makeDevice()
        thinq.emit('data', SAMPLE_INITIAL)
        thinq.resetRecorder()

        dev.setProperty('does-not-exist', '1')
        assert.equal(thinq.outbox.length, 0)
    })
})
