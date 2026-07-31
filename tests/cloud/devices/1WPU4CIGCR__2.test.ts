import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/1WPU4CIGCR__2'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-id'
const MODEL_ID = '1WPU4CIGCR__2'
const META: Metadata = { modelId: MODEL_ID, modelName: MODEL_ID, swVersion: '1.0' }

// Real captures from a 1WPU4CIGCR__2 (LG 정수기, deviceType 103).
// Frame: AA 0x3A 12 EC <26 bytes previous record> <26 bytes current record> <cksum> BB.

// The tap's UV lamp finishing its cycle: cockState 1 in the previous record, 0 in the current one.
const SAMPLE_UV_DONE = buf(
    'AA3A12EC' +
        '020103010101FFFF01FF030101FFFF08041000FF01FF00000001' +
        '020003010101FFFF01FF030101FFFF08041000FF01FF00000001' +
        '78BB',
)

// The panel switched the amount from 120ml to 250ml - byte 3, and nothing else, moved.
const SAMPLE_AMOUNT_250 = buf(
    'AA3A12EC' +
        '020003010101FFFF01FF030101FFFF08041000FF01FF00000001' +
        '020003020101FFFF01FF030101FFFF08041000FF01FF00000001' +
        '78BB',
)

// The dispensed totals. The cloud read coldWaterAmount 252 at this moment, which is the 0x00FC.
const SAMPLE_COUNTERS = buf('AA12121F0000000000FC000000000000BCBB')

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
            'uvnano',
            'water_selection',
            'water_amount',
            'status',
            'sterilize_schedule',
            'default_water',
            'default_water_amount',
            'auto_care',
            'button_sound',
            'not_use_notice',
            'hot_water_total',
            'normal_water_total',
            'cold_water_total',
            'sterilised_water_total',
            'mineral_water_total',
            'sparkling_water_total',
        ]) {
            assert.ok(components[key], `${key} declared`)
        }
        assert.equal(Object.keys(components).length, 16)
    })

    test('the fields the model names, as the cloud read them at the same moment', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_UV_DONE)

        const p = props(ha)
        assert.equal(p.status, 'Normal')
        assert.equal(p.uvnano, 'Standby')
        assert.equal(p.water_selection, 'Cold')
        assert.equal(p.water_amount, '120 ml')
        assert.equal(p.default_water, 'Cold')
        assert.equal(p.default_water_amount, '120 ml')
        assert.equal(p.auto_care, 'ON')
        assert.equal(p.button_sound, 'ON')
        assert.equal(p.not_use_notice, 'ON')
        assert.equal(p.sterilize_schedule, '08-04 16:00')
    })

    test('the UV lamp is reported while it runs', () => {
        const { ha, thinq } = makeDevice()
        // the previous record of that frame is the lamp running; feed it as a current one
        thinq.emit(
            'data',
            buf(
                'AA3A12EC' +
                    '020003010101FFFF01FF030101FFFF08041000FF01FF00000001' +
                    '020103010101FFFF01FF030101FFFF08041000FF01FF00000001' +
                    '78BB',
            ),
        )
        assert.equal(props(ha).uvnano, 'Cleaning')
    })

    test('the selected amount follows the panel', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_AMOUNT_250)
        assert.equal(props(ha).water_amount, '250 ml')
        // and nothing else moved with it
        assert.equal(props(ha).water_selection, 'Cold')
        assert.equal(props(ha).default_water_amount, '120 ml')
    })

    test('the dispensed totals are six counters, one per tap', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_COUNTERS)

        const p = props(ha)
        assert.equal(p.cold_water_total, 252)
        assert.equal(p.hot_water_total, 0)
        assert.equal(p.normal_water_total, 0)
        assert.equal(p.sterilised_water_total, 0)
        assert.equal(p.mineral_water_total, 0)
        assert.equal(p.sparkling_water_total, 0)
    })

    test('the counters are 16-bit, so a total past 255 still reads right', () => {
        const { ha, thinq } = makeDevice()
        // same frame shape with 0x1234 on the cold tap
        thinq.emit('data', buf('AA12121F000000001234000000000000' + '00BB'))
        assert.equal(props(ha).cold_water_total, 0x1234)
    })

    test('frames of other types and malformed frames are ignored', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_UV_DONE)
        const before = { ...props(ha) }

        thinq.emit('data', buf('AA0A12E2440102591DBB')) // 0xE2, not decoded
        thinq.emit('data', buf('AA0912AF0D0003D1BB')) // 0xAF, not decoded
        thinq.emit('data', buf('001122')) // not an AABB frame at all
        thinq.emit('data', buf('AA0612EC0000BB')) // 0x12EC but far too short
        thinq.emit('data', buf('AA0A121F000000BB')) // counters, but not six of them

        assert.deepEqual(props(ha), before)
    })
})
