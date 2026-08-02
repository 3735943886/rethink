import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/CST_170004_WW'
import type { Metadata } from '@/cloud/thinq'
import * as TLV from '@/util/tlv'
import crc16 from '@/util/crc16'
import { MockHAConnection, MockThinq2Device } from '@/tests/helpers/mocks'
import { enableMockTimers, tickMockTimers } from '@/tests/helpers/timers'
import { ReservationJSONStore, type ReservationDeadlines, type ReservationStore } from '@/bridge/reservation-store'
import HABridge from '@/cloud/ha_bridge'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DEVICE_ID = 'test-id'
const MODEL_ID = 'CST_170004_WW'
const META: Metadata = { modelId: MODEL_ID, modelName: 'LG 에어컨', swVersion: '1.0' }

/*
 * Values captured from the seven installed CST units and documented in the driver:
 * feature caps 0x2cb=0x1006, jet/swing caps 0x2cd=0x1fe7b7, temperature range
 * 16-30 C, mode cool=0, fan auto=8, temperatures 29/18 C, power 177 W,
 * humidity 47%, display 50%, and vertical vane position 4.
 */
const CAPS: TLV.TLV[] = [
    { t: 0x2cb, v: 0x1006 },
    { t: 0x2cd, v: 0x1fe7b7 },
    { t: 0x2d3, v: 1 },
    { t: 0x2da, v: 0x1234 },
    { t: 0x2e1, v: 32 },
    { t: 0x2e2, v: 60 },
]

const VALUES: TLV.TLV[] = [
    { t: 0x1f7, v: 1 },
    { t: 0x1f9, v: 0 },
    { t: 0x1fa, v: 8 },
    { t: 0x1fd, v: 58 },
    { t: 0x1fe, v: 36 },
    { t: 0x205, v: 1 },
    { t: 0x206, v: 0 },
    { t: 0x20e, v: 3 },
    { t: 0x21f, v: 150 },
    { t: 0x225, v: 10 },
    { t: 0x23f, v: 0 },
    { t: 0x2b3, v: 177 },
    { t: 0x2b5, v: 3469 },
    { t: 0x321, v: 4 },
    { t: 0x336, v: 470 },
    { t: 0x355, v: 47 },
    { t: 0x356, v: 2400 },
    { t: 0x3d6, v: 0 },
]

function deviceFrame(fields: TLV.TLV[], subcommand: 0x01 | 0x04) {
    const payload = TLV.build(fields)
    const body = [0x04, 0x00, 0x00, 0x00, 0xa7, 0x02, subcommand, 0x01, payload.length, ...payload]
    const crc = crc16(body)
    return Buffer.from([0x00, 0x00, ...body, crc >> 8, crc & 0xff])
}

function writtenFields(thinq: MockThinq2Device) {
    const packet = thinq.outbox[thinq.outbox.length - 1]
    assert.ok(packet, 'a packet was sent')
    return TLV.parse(packet.subarray(11, packet.length - 2)).map(({ t, v }) => ({ t, v }))
}

class RecordingReservationStore implements ReservationStore {
    saved: ReservationDeadlines[] = []

    load() {
        return {}
    }

    save(_id: string, deadlines: ReservationDeadlines) {
        const stored: ReservationDeadlines = {}
        if (deadlines.start != null) stored.start = deadlines.start
        if (deadlines.stop != null) stored.stop = deadlines.stop
        this.saved.push(stored)
    }
}

function makeDevice(store?: ReservationStore) {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    if (store) dev.setReservationStore(store)
    return { ha, thinq, dev }
}

function makeBridgedDevice(store: ReservationStore) {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const bridge = new HABridge(ha.asConnection(), store)
    bridge.newDevice(thinq)
    const dev = bridge.haDevices.get(DEVICE_ID)
    assert.ok(dev instanceof DUT)
    return { bridge, dev }
}

function temporaryDirectory(t: import('node:test').TestContext) {
    const path = mkdtempSync(join(tmpdir(), 'rethink-cst-reservation-'))
    t.after(() => rmSync(path, { recursive: true }))
    return path
}

function buildReadyDevice(t: import('node:test').TestContext) {
    enableMockTimers(t)
    const { ha, thinq, dev } = makeDevice()
    thinq.resetRecorder()
    thinq.emit('data', deviceFrame(CAPS, 0x01))
    thinq.emit('data', deviceFrame(VALUES, 0x04))
    tickMockTimers(t, 1000)
    thinq.resetRecorder()
    return { ha, thinq, dev }
}

describe(MODEL_ID, () => {
    test('captured capabilities publish the CST climate configuration', (t) => {
        const { ha, dev } = buildReadyDevice(t)
        const components = ha.devices[DEVICE_ID]!.config!.components as Record<string, Record<string, unknown>>

        assert.deepEqual(components.climate.modes, ['off', 'cool', 'dry', 'fan_only', 'auto'])
        assert.deepEqual(components.climate.fan_modes, ['자동풍', '미약풍', '약풍', '중풍', '강풍', '파워풍'])
        assert.deepEqual(components.climate.swing_modes, ['정지', '상하', '좌우', '자동'])
        /*
         * The vane position rides HA's second swing attribute rather than a select of its own: it
         * is the only remaining slot the more-info dialog renders, which is where these units are
         * operated from. The label HA puts on it ("가로 스윙 모드") is wrong for a vertical vane and
         * is accepted deliberately - see swingAxes() in the driver.
         */
        assert.deepEqual(components.climate.swing_horizontal_modes, [
            '정지',
            '1단(위)',
            '2단',
            '3단',
            '4단',
            '5단',
            '6단(아래)',
        ])
        assert.deepEqual(components.climate.preset_modes, ['송풍2h off', '파워풍'])
        assert.equal(components.climate.min_temp, 16)
        assert.equal(components.climate.max_temp, 30)
        assert.ok(components.autodry_setting)
        assert.ok(components.energysave)
        assert.ok(!components.jet)

        dev.drop()
    })

    test('captured initial state decodes CST climate and diagnostic values', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t)
        thinq.emit('data', deviceFrame(VALUES, 0x04))

        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'mode_state'), 'cool')
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'fan_mode_state'), '자동풍')
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'current_temperature'), 29)
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'temperature_state'), 18)
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'swing_mode_state'), '상하')
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'swing_horizontal_mode_state'), '4단')
        assert.equal(ha.getProperty(DEVICE_ID, 'humidity', 'state'), 47)
        assert.equal(ha.getProperty(DEVICE_ID, 'energy_current', 'state'), 177)

        dev.drop()
    })

    test('power-off writes only power TLV 0x1f7=0', (t) => {
        const { thinq, dev } = buildReadyDevice(t)
        dev.setProperty('climate-power', 'OFF')
        assert.deepEqual(writtenFields(thinq), [{ t: 0x1f7, v: 0 }])
        dev.drop()
    })

    test('dry mode writes mode TLV and required powered-on context', (t) => {
        const { thinq, dev } = buildReadyDevice(t)
        dev.setProperty('climate-mode', 'dry')
        assert.deepEqual(writtenFields(thinq), [
            { t: 0x1f9, v: 1 },
            { t: 0x1f7, v: 1 },
            { t: 0x1fa, v: 8 },
            { t: 0x1fe, v: 36 },
        ])
        dev.drop()
    })

    test('strong fan writes fan TLV 0x1fa=6 with mode and target context', (t) => {
        const { thinq, dev } = buildReadyDevice(t)
        dev.setProperty('climate-fan_mode', '강풍')
        assert.deepEqual(writtenFields(thinq), [
            { t: 0x1fa, v: 6 },
            { t: 0x1f9, v: 0 },
            { t: 0x1fe, v: 36 },
        ])
        dev.drop()
    })

    test('20.5 C target writes half-degree TLV 0x1fe=41', (t) => {
        const { thinq, dev } = buildReadyDevice(t)
        dev.setProperty('climate-temperature', '20.5')
        assert.deepEqual(writtenFields(thinq), [
            { t: 0x1fe, v: 41 },
            { t: 0x1f9, v: 0 },
            { t: 0x1fa, v: 8 },
        ])
        dev.drop()
    })

    /*
     * A setpoint cannot ride the frame that ends 파워풍 - the appliance puts the previous setpoint
     * back while it leaves, ignoring the one being asked for. So it takes two frames, and the
     * second waits for the appliance's own report that 파워풍 is over. See the driver.
     */
    test('a setpoint asked for in 파워풍 ends 파워풍 first and lands on the appliance report', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t)
        thinq.emit('data', deviceFrame([{ t: 0x1fa, v: 7 }], 0x04))
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'preset_mode_state'), '파워풍')
        thinq.resetRecorder()

        dev.setProperty('climate-temperature', '26')

        /* first frame: end 파워풍. The 0x1fe it carries is the appliance's own pinned 18 degC. */
        assert.deepEqual(writtenFields(thinq), [
            { t: 0x1fa, v: 6 },
            { t: 0x1f9, v: 0 },
            { t: 0x1fe, v: 36 },
        ])

        /* the appliance answers: out of 파워풍, setpoint restored to the 27 degC it had before */
        thinq.emit(
            'data',
            deviceFrame(
                [
                    { t: 0x1fe, v: 54 },
                    { t: 0x1fa, v: 6 },
                ],
                0x04,
            ),
        )

        /* second frame: the setpoint HA asked for */
        assert.deepEqual(writtenFields(thinq), [
            { t: 0x1fe, v: 52 },
            { t: 0x1f9, v: 0 },
            { t: 0x1fa, v: 6 },
        ])
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'preset_mode_state'), 'none')
        dev.drop()
    })

    /* One held setpoint, one retry - a later fan change of the operator's own must not replay it. */
    test('the held setpoint is written once and not replayed on a later fan change', (t) => {
        const { thinq, dev } = buildReadyDevice(t)
        thinq.emit('data', deviceFrame([{ t: 0x1fa, v: 7 }], 0x04))
        thinq.resetRecorder()

        dev.setProperty('climate-temperature', '26')
        thinq.emit('data', deviceFrame([{ t: 0x1fa, v: 6 }], 0x04))
        const written = thinq.outbox.length
        assert.equal(written, 2, 'the frame that ended 파워풍 and the setpoint')

        thinq.emit('data', deviceFrame([{ t: 0x1fa, v: 8 }], 0x04))

        assert.equal(thinq.outbox.length, written, 'a later fan change writes nothing')
        dev.drop()
    })

    /* Out of 파워풍 nothing changes: the temperature field writes its own frame as before. */
    test('a setpoint asked for at any other fan speed still writes the target first', (t) => {
        const { thinq, dev } = buildReadyDevice(t)
        thinq.emit('data', deviceFrame([{ t: 0x1fa, v: 6 }], 0x04))
        thinq.resetRecorder()

        dev.setProperty('climate-temperature', '26')

        assert.deepEqual(writtenFields(thinq), [
            { t: 0x1fe, v: 52 },
            { t: 0x1f9, v: 0 },
            { t: 0x1fa, v: 6 },
        ])
        dev.drop()
    })

    test('left-right swing writes the measured 0x205 and 0x206 flag pair', (t) => {
        const { thinq, dev } = buildReadyDevice(t)
        dev.setProperty('climate-swing_mode', '좌우')
        assert.deepEqual(writtenFields(thinq), [
            { t: 0x205, v: 0 },
            { t: 0x206, v: 1 },
        ])
        dev.drop()
    })

    test('power transitions satisfy only the reservation matching the new state', (t) => {
        enableMockTimers(t)
        const store = new RecordingReservationStore()
        const { thinq, dev } = makeDevice(store)
        dev.start()
        thinq.emit('data', deviceFrame(CAPS, 0x01))
        thinq.emit('data', deviceFrame(VALUES, 0x04))
        tickMockTimers(t, 1000)

        dev.setReservation('start', 30)
        dev.setReservation('stop', 45)
        const initialDeadlines = { ...dev.resDeadline }

        // The first power report is a baseline, not a transition.
        thinq.emit('data', deviceFrame([{ t: 0x1f7, v: 0 }], 0x04))
        assert.deepEqual(dev.resDeadline, initialDeadlines)

        thinq.emit('data', deviceFrame([{ t: 0x1f7, v: 1 }], 0x04))
        assert.equal(dev.resDeadline.start, undefined)
        assert.equal(dev.resDeadline.stop, initialDeadlines.stop)
        assert.deepEqual(store.saved[store.saved.length - 1], { stop: initialDeadlines.stop })

        dev.setReservation('start', 30)
        const replacementStart = dev.resDeadline.start
        thinq.emit('data', deviceFrame([{ t: 0x1f7, v: 0 }], 0x04))
        assert.equal(dev.resDeadline.start, replacementStart)
        assert.equal(dev.resDeadline.stop, undefined)
        assert.deepEqual(store.saved[store.saved.length - 1], { start: replacementStart })

        dev.drop()
    })

    test('reservation deadlines restore across driver restart and cancellation persists', (t) => {
        enableMockTimers(t)
        const store = new ReservationJSONStore(temporaryDirectory(t))
        const firstConnection = makeBridgedDevice(store)
        const first = firstConnection.dev
        first.setReservation('start', 30)
        first.setReservation('stop', 45)
        const persisted = { ...first.resDeadline }
        firstConnection.bridge.dropDevice(first)

        const secondConnection = makeBridgedDevice(store)
        const second = secondConnection.dev
        assert.deepEqual(second.resDeadline, persisted)
        second.setReservation('start', 0)
        secondConnection.bridge.dropDevice(second)

        const thirdConnection = makeBridgedDevice(store)
        const third = thirdConnection.dev
        assert.deepEqual(third.resDeadline, { stop: persisted.stop })
        thirdConnection.bridge.dropDevice(third)
    })

    test('firing a reservation persists its removal before sending power', (t) => {
        enableMockTimers(t)
        const store = new RecordingReservationStore()
        const { thinq, dev } = makeDevice(store)
        dev.start()
        thinq.emit('data', deviceFrame(CAPS, 0x01))
        thinq.emit('data', deviceFrame(VALUES, 0x04))
        tickMockTimers(t, 1000)
        thinq.resetRecorder()

        dev.setReservation('start', 1)
        dev.resDeadline.start = 0
        dev.reservationTick()

        assert.deepEqual(store.saved[store.saved.length - 1], {})
        assert.deepEqual(writtenFields(thinq), [
            { t: 0x1f7, v: 1 },
            { t: 0x1f9, v: 0 },
            { t: 0x1fa, v: 8 },
            { t: 0x1fe, v: 36 },
        ])

        dev.drop()
    })
})
