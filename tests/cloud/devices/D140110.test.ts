import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/D140110'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-id'
const MODEL_ID = 'D140110'
const META: Metadata = { modelId: MODEL_ID, modelName: MODEL_ID, swVersion: '1.0' }

// Real captures from a D140110 (LG 식기세척기, deviceType 204) over one full 1:33 Auto cycle.
// Frame: AA 0x3A 32 EC <26 bytes previous record> <26 bytes current record> <cksum> BB, where a
// record is <flags> 18 <24 bytes of payload>.

// Ready to start: the Auto course selected, the full 1:33 on the clock, nothing running.
const SAMPLE_READY = buf(
    'AA3A32EC' +
        '0018000000012100000001000012000000000000000000000000' +
        '0818010000012101000121000010000200090000000000000001' +
        '84BB',
)

// Under way.
const SAMPLE_RUNNING = buf(
    'AA3A32EC' +
        '0018010000012101000121000010000200090000000000000001' +
        '0018020200012101000121000010000200090000000000000001' +
        'ACBB',
)

// The panel locked mid-cycle - flags 0x10 -> 0x11. The cloud reported childLock ON within the second.
const SAMPLE_CHILD_LOCK = buf(
    'AA3A32EC' +
        '001802020001210100011D000010000200090000000000000001' +
        '001802020001210100011D000011000200090000000000000001' +
        'A0BB',
)

// Rinsing, nine minutes left.
const SAMPLE_RINSING = buf(
    'AA3A32EC' +
        '001802030001210100000A000010000200090000000000000001' +
        '0018020300012101000009000010000200090000000000000001' +
        '98BB',
)

// Drying.
const SAMPLE_DRYING = buf(
    'AA3A32EC' +
        '0018020300012101000009000010000200090000000000000001' +
        '0018020400012101000009000010000200090000000000000001' +
        '98BB',
)

// The auto-open door swung out during drying - flags 0x10 -> 0x12.
const SAMPLE_DOOR_OPEN = buf(
    'AA3A32EC' +
        '0018020400012101000002000010000200090000000000000001' +
        '0018020400012101000002000012000200090000000000000001' +
        '97BB',
)

// The cycle finished, door still open.
const SAMPLE_FINISHED = buf(
    'AA3A32EC' +
        '0018020400012101000001000012000200090000000000000001' +
        '0018050500012101000001000012000200090000000000000001' +
        '93BB',
)

// Standby a minute later - the course resets to none.
const SAMPLE_STANDBY = buf(
    'AA3A32EC' +
        '0018050500012101000001000012000200090000000000000001' +
        '0818040000012100000001000012000200090000000000000001' +
        '9EBB',
)

// And then off.
const SAMPLE_OFF = buf(
    'AA3A32EC' +
        '0018040000012100000001000012000200090000000000000001' +
        '0018000000012100000001000012000200090000000000000001' +
        'EDBB',
)

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    return { ha, thinq, dev }
}

function props(ha: MockHAConnection) {
    return ha.devices[DEVICE_ID].properties
}

describe(MODEL_ID, () => {
    test('config is published up front', () => {
        const { ha } = makeDevice()
        const components = ha.devices[DEVICE_ID]?.config?.components
        assert.ok(components, 'config published')

        for (const key of [
            'status',
            'process',
            'course',
            'error',
            'running',
            'door',
            'child_lock',
            'chime',
            'rinse_refill',
            'salt_refill',
            'total_time',
            'remaining_time',
            'reserve_time',
            'rinse_aid_level',
            'softening_level',
        ]) {
            assert.ok(components[key], `${key} declared`)
        }
        assert.equal(Object.keys(components).length, 15)
    })

    test('ready to start: the course and the full cycle time', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_READY)

        const p = props(ha)
        assert.equal(p.status, 'Ready')
        assert.equal(p.process, 'None')
        assert.equal(p.course, 'Auto')
        assert.equal(p.error, 'No error')
        assert.equal(p.running, 'OFF')
        assert.equal(p.total_time, 93) // 1:33, the 93 minutes the app showed
        assert.equal(p.remaining_time, 93)
        assert.equal(p.reserve_time, 0)
        assert.equal(p.door, 'OFF')
        assert.equal(p.child_lock, 'OFF')
        assert.equal(p.chime, 'ON')
        assert.equal(p.rinse_refill, 'OFF')
        assert.equal(p.salt_refill, 'OFF')
        assert.equal(p.rinse_aid_level, 2)
        assert.equal(p.softening_level, 0)
    })

    test('running', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_RUNNING)

        const p = props(ha)
        assert.equal(p.status, 'Running')
        assert.equal(p.process, 'Washing')
        assert.equal(p.running, 'ON')
    })

    test('the phases of a cycle are reported apart from the state', () => {
        const { ha, thinq } = makeDevice()

        thinq.emit('data', SAMPLE_RINSING)
        assert.equal(props(ha).process, 'Rinsing')
        assert.equal(props(ha).status, 'Running') // the state stays RUNNING throughout
        assert.equal(props(ha).remaining_time, 9)

        thinq.emit('data', SAMPLE_DRYING)
        assert.equal(props(ha).process, 'Drying')
        assert.equal(props(ha).status, 'Running')
    })

    test('the child lock does not disturb anything else', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_RUNNING)
        thinq.emit('data', SAMPLE_CHILD_LOCK)

        const p = props(ha)
        assert.equal(p.child_lock, 'ON')
        assert.equal(p.status, 'Running')
        assert.equal(p.chime, 'ON') // the same byte, other bit
        assert.equal(p.door, 'OFF')
        assert.equal(p.remaining_time, 89) // 1:29
    })

    test('the auto-open door is reported without ending the cycle', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_DRYING)
        thinq.emit('data', SAMPLE_DOOR_OPEN)

        const p = props(ha)
        assert.equal(p.door, 'ON')
        assert.equal(p.status, 'Running')
        assert.equal(p.process, 'Drying')
        assert.equal(p.child_lock, 'OFF')
    })

    test('finished, then standby, then off', () => {
        const { ha, thinq } = makeDevice()

        thinq.emit('data', SAMPLE_FINISHED)
        assert.equal(props(ha).status, 'Finished')
        assert.equal(props(ha).process, 'Finished')
        assert.equal(props(ha).running, 'OFF')
        assert.equal(props(ha).course, 'Auto')
        assert.equal(props(ha).door, 'ON')

        thinq.emit('data', SAMPLE_STANDBY)
        assert.equal(props(ha).status, 'Standby')
        assert.equal(props(ha).course, 'None') // the course clears as the cycle ends
        assert.equal(props(ha).process, 'None')

        thinq.emit('data', SAMPLE_OFF)
        assert.equal(props(ha).status, 'Off')
    })

    test('frames of other types and malformed frames are ignored', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_RUNNING)
        const before = { ...props(ha) }

        thinq.emit('data', buf('AA0932D80400BB')) // 0xD8 process hint, not decoded
        thinq.emit('data', buf('AA0B327200000000BB')) // 0x72 end-of-cycle chime, not decoded
        thinq.emit('data', buf('AA2032B2000818010000012101000121000010000200090000000000000001BB')) // 0xB2
        thinq.emit('data', buf('001122')) // not an AABB frame at all
        thinq.emit('data', buf('AA0632EC0000BB')) // 0x32EC but far too short

        assert.deepEqual(props(ha), before)
    })
})
