import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/WBEY3GT'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-id'
const MODEL_ID = 'WBEY3GT'
const META: Metadata = { modelId: MODEL_ID, modelName: MODEL_ID, swVersion: '1.0' }

// Real captures from a WBEY3GT (LG 전기레인지, deviceType 303), taken a ring at a time so that each
// burner group could be tied to the ring it belongs to.
// Frame: AA 0x66 42 EC <48 bytes previous state> <48 bytes current state> <cksum> BB.

const BURNERS = ['left_rear', 'left_front', 'right']

// Everything off - the right ring had been running at 9 and was switched off at the panel.
const SAMPLE_IDLE = buf(
    'AA6642EC' +
        '00000000000000000000000109010400013B370000000000000000000000000000000000000000000000000000000000' +
        '000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000' +
        '95BB',
)

// Straight after the mains switch: every burner reads LOCK, including the RR group that is not a
// burner on this model, and the panel needs unlocking before anything can be set.
const SAMPLE_POWER_ON_LOCKED = buf(
    'AA6642EC' +
        '010000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000' +
        '000003000000000000000003000000000000000003000000000000000003000000000000000000000000000000000000' +
        '1EBB',
)

// Right ring set to 9, not lit yet: state still 0, the hour of auto-off armed but not counting.
const SAMPLE_ARMED = buf(
    'AA6642EC' +
        '000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000' +
        '000000000000000000000000090000000100000100000000000000000000000000000000000000000000000000000000' +
        '1CBB',
)

// Right ring alight at 9, one second in.
const SAMPLE_COOKING = buf(
    'AA6642EC' +
        '000000000000000000000000090000000100000100000000000000000000000000000000000000000000000000000000' +
        '00000000000000000000000109010000013B3B0000000000000000000000000000000000000000000000000000000000' +
        '9EBB',
)

// Left rear lit at 5 two minutes into the right ring's hour. Each ring counts its own auto-off: the
// right one is 2:01 in with 57:59 left, the left rear 0:02 in with 59:58 left. The right ring's
// TimerDisp has gone to 0 because the panel is now showing the newly selected ring's timer - its
// countdown is running all the same.
const SAMPLE_TWO_BURNERS = buf(
    'AA6642EC' +
        '0000000000000000000000010900020000003A000105010000013B3B0000000000000000000000000000000000000000' +
        '00000000000000000000000109010200003B39000105020000013A3B0000000000000000000000000000000000000000' +
        '54BB',
)

// The panel locked with both rings alight: every state byte reads 3, the two that are cooking keep
// their power level and both counters.
const SAMPLE_LOCKED_WHILE_COOKING = buf(
    'AA6642EC' +
        '00000000000000000000000109010200003B39000105020000013A3B0000000000000000000000000000000000000000' +
        '000003000000000000000003091C02000020390003051D0000011F3B0003000000000000000000000000000000000000' +
        '13BB',
)

// Unlocked again a few seconds later, both rings still going.
const SAMPLE_UNLOCKED = buf(
    'AA6642EC' +
        '000003000000000000000003091C02000020390003051D0000011F3B0003000000000000000000000000000000000000' +
        '00000000000000000000000109200200001C39000105210000011B3B0000000000000000000000000000000000000000' +
        '13BB',
)

// The panel's remote-control button pressed: WiFiAccess bit 1.
const SAMPLE_REMOTE_START = buf(
    'AA6642EC' +
        '000000000000000000000001092402000118390000000000000000000000000000000000000000000000000000000000' +
        '020000000000000000000001092502000117390000000000000000000000000000000000000000000000000000000000' +
        '11BB',
)

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    return { ha, thinq, dev }
}

describe(MODEL_ID, () => {
    test('config is published up front, with an entity set per burner', () => {
        const { ha } = makeDevice()
        const components = ha.devices[DEVICE_ID]?.config?.components
        assert.ok(components, 'config published')

        // three burners x five entities, plus cooking, locked, remote_start and power_off
        assert.equal(Object.keys(components).length, 3 * 5 + 4)
        for (const key of BURNERS) {
            for (const suffix of ['state', 'power_level', 'cook_time', 'remaining_time', 'off']) {
                assert.ok(components[`${key}_${suffix}`], `${key}_${suffix} declared`)
            }
        }
    })

    test('every control is unavailable until the panel grants remote start', () => {
        const { ha } = makeDevice()
        const components = ha.devices[DEVICE_ID].config?.components as Record<string, any>
        assert.ok(components)

        for (const key of ['power_off', 'right_off', 'right_remaining_time']) {
            const gate = components[key].availability?.find((a: any) => a.topic === '$this/remote_start')
            assert.ok(gate, `${key} gated on remote start`)
            assert.equal(gate.payload_available, 'ON')
            assert.equal(components[key].availability_mode, 'all')
        }

        // and a read-only entity is not gated - it should still report while remote start is off
        assert.equal(components.right_power_level.availability, undefined)
    })

    test('idle: every burner off, nothing locked, no remote start', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_IDLE)

        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.cooking, 'OFF')
        assert.equal(props.locked, 'OFF')
        assert.equal(props.remote_start, 'OFF')
        for (const key of BURNERS) {
            assert.equal(props[`${key}_state`], 'Off')
            assert.equal(props[`${key}_power_level`], 0)
            assert.equal(props[`${key}_cook_time`], 0)
            assert.equal(props[`${key}_remaining_time`], 0)
        }
    })

    test('locked from cold: the lock shows, but nothing is reported as cooking', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_POWER_ON_LOCKED)

        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.locked, 'ON')
        assert.equal(props.cooking, 'OFF')
        for (const key of BURNERS) assert.equal(props[`${key}_state`], 'Off')
    })

    test('power level set before the ring lights: level reported, state still off', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_ARMED)

        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.right_power_level, 9)
        assert.equal(props.right_state, 'Off')
        assert.equal(props.cooking, 'OFF')
        // the hour of auto-off is already on the clock
        assert.equal(props.right_remaining_time, 60)
    })

    test('cooking: state, level and both timers', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_COOKING)

        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.cooking, 'ON')
        assert.equal(props.right_state, 'Cooking')
        assert.equal(props.right_power_level, 9)
        assert.equal(props.right_cook_time, 0) // 0:00:01
        assert.equal(props.right_remaining_time, 59) // 0:59:59

        // the other rings stay untouched
        assert.equal(props.left_rear_state, 'Off')
        assert.equal(props.left_front_power_level, 0)
    })

    test('two rings at once keep separate counters', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_TWO_BURNERS)

        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.right_power_level, 9)
        assert.equal(props.right_cook_time, 2) // 0:02:01
        // TimerDisp is 0 on this ring - the panel is showing the other one - and the countdown is
        // still running, so it has to be reported
        assert.equal(props.right_remaining_time, 57) // 0:57:59

        assert.equal(props.left_rear_power_level, 5)
        assert.equal(props.left_rear_cook_time, 0) // 0:00:02
        assert.equal(props.left_rear_remaining_time, 59) // 0:59:58
    })

    test('locking mid-cook does not put the rings out', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_TWO_BURNERS)
        thinq.emit('data', SAMPLE_LOCKED_WHILE_COOKING)

        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.locked, 'ON')
        assert.equal(props.cooking, 'ON')
        assert.equal(props.right_state, 'Cooking')
        assert.equal(props.left_rear_state, 'Cooking')
        // the rings that are not alight read as off, not as locked
        assert.equal(props.left_front_state, 'Off')
        // and the counters carried straight on under the lock
        assert.equal(props.right_cook_time, 2) // 0:02:28
        assert.equal(props.right_remaining_time, 57) // 0:57:32
        assert.equal(props.left_rear_cook_time, 0) // 0:00:29
        assert.equal(props.left_rear_remaining_time, 59) // 0:59:31
    })

    test('unlocking leaves the cook alone', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_LOCKED_WHILE_COOKING)
        thinq.emit('data', SAMPLE_UNLOCKED)

        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.locked, 'OFF')
        assert.equal(props.cooking, 'ON')
        assert.equal(props.right_state, 'Cooking')
        assert.equal(props.left_rear_state, 'Cooking')
    })

    test('the panel granting remote start shows up', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_REMOTE_START)
        assert.equal(ha.devices[DEVICE_ID].properties.remote_start, 'ON')
    })

    test('switched off: everything clears', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_COOKING)
        thinq.emit('data', SAMPLE_IDLE)

        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.cooking, 'OFF')
        assert.equal(props.right_state, 'Off')
        assert.equal(props.right_power_level, 0)
        assert.equal(props.right_cook_time, 0)
        assert.equal(props.right_remaining_time, 0)
    })

    test('the previous-state record in the frame is ignored', () => {
        const { ha, thinq } = makeDevice()
        // SAMPLE_IDLE carries the last cooking state as its previous record; only the current one counts
        thinq.emit('data', SAMPLE_IDLE)
        assert.equal(ha.devices[DEVICE_ID].properties.right_state, 'Off')
    })

    // The command frames below are the ones the LG app sent, byte for byte.
    function inner(thinq: MockThinq2Device) {
        assert.equal(thinq.outbox.length, 1, 'exactly one packet sent')
        // strip AA + length and checksum + BB
        return thinq.outbox[0].subarray(2, -2).toString('hex').toUpperCase()
    }

    test('switching a burner off names that burner', () => {
        const { thinq, dev } = makeDevice()
        thinq.emit('data', SAMPLE_REMOTE_START) // right ring at 9, remote start granted
        dev.setProperty('right_off', 'PRESS')
        assert.equal(inner(thinq), 'F043200805000000' + '00000000')
    })

    test('setting a timer restates the burner power level', () => {
        const { thinq, dev } = makeDevice()
        thinq.emit('data', SAMPLE_REMOTE_START)
        dev.setProperty('right_remaining_time', '56')
        // burner 5, still at level 9, 0h 56m
        assert.equal(inner(thinq), 'F043200805090038' + '00000000')
    })

    test('a timer past the appliance maximum is clamped, not wrapped', () => {
        const { thinq, dev } = makeDevice()
        thinq.emit('data', SAMPLE_REMOTE_START)
        dev.setProperty('right_remaining_time', '9999')
        // 11:59, the most ControlTimerHour/Min can carry
        assert.equal(inner(thinq), 'F043200805090B3B' + '00000000')
    })

    test('switching the whole cooktop off', () => {
        const { thinq, dev } = makeDevice()
        thinq.emit('data', SAMPLE_REMOTE_START)
        dev.setProperty('power_off', 'PRESS')
        assert.equal(inner(thinq), 'F04400')
    })

    test('nothing is sent while the panel withholds remote start', () => {
        const { thinq, dev } = makeDevice()
        thinq.emit('data', SAMPLE_COOKING) // cooking, but remote start not granted
        dev.setProperty('right_off', 'PRESS')
        dev.setProperty('power_off', 'PRESS')
        assert.equal(thinq.outbox.length, 0)
    })

    test('a timer on a ring that is not lit is not sent', () => {
        const { thinq, dev } = makeDevice()
        thinq.emit('data', SAMPLE_REMOTE_START)
        // the left rear ring is off in that frame, and a level of 0 would mean "switch off"
        dev.setProperty('left_rear_remaining_time', '30')
        assert.equal(thinq.outbox.length, 0)
    })

    test('frames of other types and malformed frames are ignored', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_COOKING)
        const before = { ...ha.devices[DEVICE_ID].properties }

        thinq.emit('data', buf('AA12426500000000000000000000000432BB')) // 0x65, switch-off, not decoded
        thinq.emit('data', buf('AA13427207E40A0000000000000000000033BB')) // 0x72, not decoded
        thinq.emit('data', buf('001122')) // not an AABB frame at all
        thinq.emit('data', buf('AA0642EC0000BB')) // 0x42EC but far too short

        assert.deepEqual(ha.devices[DEVICE_ID].properties, before)
    })
})
