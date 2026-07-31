import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/WBEY3GT'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-id'
const MODEL_ID = 'WBEY3GT'
const META: Metadata = { modelId: MODEL_ID, modelName: MODEL_ID, swVersion: '1.0' }

// Real captures from a WBEY3GT (LG 전기레인지, deviceType 303), one ~6 minute cook on a single ring.
// Frame: AA 0x66 42 EC <48 bytes previous state> <48 bytes current state> <cksum> BB.
// The ring that moved occupies bytes 11..19, which the model description calls Left Rear.

// Everything off. Byte 0 (WiFiAccess) = 1: firmware updates enabled, remote start not.
const SAMPLE_IDLE = buf(
    'AA6642EC' + // AA 66 42 EC
        '010000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000' + // previous record
        '010000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000' + // current record
        '15BB', // cksum BB
)

// Power level set to 9, ring not lit yet (state still 0), auto-off timer armed at 1 hour
// (TimerDisp=1, TimerHour=1) but not yet counting.
const SAMPLE_LEVEL_SET = buf(
    'AA6642EC' +
        '000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000' +
        '000000000000000000000000090000000100000100000000000000000000000000000000000000000000000000000000' +
        '1CBB',
)

// Lit: state=1, level 9, elapsed 0:00:01, remaining 0:59:59.
const SAMPLE_COOKING = buf(
    'AA6642EC' +
        '000000000000000000000000090000000100000100000000000000000000000000000000000000000000000000000000' +
        '00000000000000000000000109010000013B3B0000000000000000000000000000000000000000000000000000000000' +
        '9EBB',
)

// Level turned down to 3 mid-cook. Elapsed 0:03:35, remaining 0:56:25 - the two sum to the 1:00:00
// the timer started from, which is what pins these four bytes as elapsed and remaining.
const SAMPLE_LEVEL_DOWN = buf(
    'AA6642EC' +
        '00000000000000000000000109010300013B380000000000000000000000000000000000000000000000000000000000' +
        '000000000000000000000001032303000119380000000000000000000000000000000000000000000000000000000000' +
        '69BB',
)

// Switched off at the panel.
const SAMPLE_OFF = buf(
    'AA6642EC' +
        '00000000000000000000000103010600013B350000000000000000000000000000000000000000000000000000000000' +
        '000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000' +
        'EFBB',
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

        // five burner groups x four entities, plus cooking and remote_start
        assert.equal(Object.keys(components).length, 5 * 4 + 2)
        for (const key of ['left_front', 'left_rear', 'right_front', 'right_rear', 'center']) {
            for (const suffix of ['state', 'power_level', 'cook_time', 'remaining_time']) {
                assert.ok(components[`${key}_${suffix}`], `${key}_${suffix} declared`)
            }
        }
    })

    test('idle: every burner off, no remote start', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_IDLE)

        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.cooking, 'OFF')
        assert.equal(props.remote_start, 'OFF')
        for (const key of ['left_front', 'left_rear', 'right_front', 'right_rear', 'center']) {
            assert.equal(props[`${key}_state`], 'Off')
            assert.equal(props[`${key}_power_level`], 0)
            assert.equal(props[`${key}_cook_time`], 0)
            assert.equal(props[`${key}_remaining_time`], 0)
        }
    })

    test('power level set before the ring lights: level reported, state still off', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_LEVEL_SET)

        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.left_rear_power_level, 9)
        assert.equal(props.left_rear_state, 'Off')
        assert.equal(props.cooking, 'OFF')
        // TimerDisp is already set and the countdown reads a whole hour
        assert.equal(props.left_rear_remaining_time, 60)
    })

    test('cooking: state, level and both timers', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_COOKING)

        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.cooking, 'ON')
        assert.equal(props.left_rear_state, 'Cooking')
        assert.equal(props.left_rear_power_level, 9)
        assert.equal(props.left_rear_cook_time, 0) // 0:00:01
        assert.equal(props.left_rear_remaining_time, 59) // 0:59:59

        // the other four groups stay untouched
        assert.equal(props.right_front_state, 'Off')
        assert.equal(props.center_power_level, 0)
    })

    test('level turned down mid-cook: elapsed and remaining still sum to the hour', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_LEVEL_DOWN)

        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.left_rear_power_level, 3)
        assert.equal(props.left_rear_state, 'Cooking')
        assert.equal(props.left_rear_cook_time, 3) // 0:03:35
        assert.equal(props.left_rear_remaining_time, 56) // 0:56:25
    })

    test('switched off: everything clears', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_COOKING)
        thinq.emit('data', SAMPLE_OFF)

        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.cooking, 'OFF')
        assert.equal(props.left_rear_state, 'Off')
        assert.equal(props.left_rear_power_level, 0)
        assert.equal(props.left_rear_cook_time, 0)
        assert.equal(props.left_rear_remaining_time, 0)
    })

    test('the previous-state record in the frame is ignored', () => {
        const { ha, thinq } = makeDevice()
        // SAMPLE_OFF carries the last cooking state as its previous record; only the current one counts
        thinq.emit('data', SAMPLE_OFF)
        assert.equal(ha.devices[DEVICE_ID].properties.left_rear_state, 'Off')
    })

    test('frames of other types and malformed frames are ignored', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_COOKING)
        const before = { ...ha.devices[DEVICE_ID].properties }

        thinq.emit('data', buf('AA1242650000000000000000000000063CBB')) // 0x65, not decoded
        thinq.emit('data', buf('001122')) // not an AABB frame at all
        thinq.emit('data', buf('AA0642EC0000BB')) // 0x42EC but far too short

        assert.deepEqual(ha.devices[DEVICE_ID].properties, before)
    })
})
