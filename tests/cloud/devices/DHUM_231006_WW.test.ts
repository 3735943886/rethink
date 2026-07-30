import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/DHUM_231006_WW'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf, hex } from '@/tests/helpers/mocks'
import { enableMockTimers, tickMockTimers } from '@/tests/helpers/timers'
import * as TLV from '@/util/tlv'
import crc16 from '@/util/crc16'

const DEVICE_ID = 'test-id'
const MODEL_ID = 'DHUM_231006_WW'
const META: Metadata = { modelId: MODEL_ID, modelName: 'TEST', swVersion: '1.0' }

/*
 * Every frame below except the two marked SYNTHETIC is a real capture from one live
 * DHUM_231006_WW, recorded through rethink's management /device socket while the owner drove
 * the appliance from the LG ThinQ app and named each action as they went. State frames are
 * marked 0xa7 at buf[6] - the quirk this profile exists to handle.
 *
 * Each fixture is labelled with the app command that caused it. The appliance echoes a write
 * about 0.5 s later, so write and echo are a matched pair throughout.
 */

/* Capability request emitted by the TLVDevice constructor (TLV 0x1f5 = 1). */
const CAPS_REQUEST_HEX = '01010400000065020201027D416A0D'
/* Values request, TLV 0x1f5 = 2, sent once capabilities arrive and every 15 min after. */
const VALUES_REQUEST_HEX = '01010400000065020201027D425A6E'

/*
 * The REAL capability reply: 134 bytes, 41 TLVs, buf[8] = 0x01. Captured by injecting
 * CAPS_REQUEST_HEX into the live appliance before this profile existed.
 *
 *      t=0x2da v=3518      eeprom checksum - what isCapsResponse() keys on
 *      t=0x2c2 v=0x751d4   selectable fan levels: bits 2,4,6,7,8 = the five this profile lists
 *      t=0x2e5 v=30        target humidity minimum
 *      t=0x2e6 v=70        target humidity maximum
 *      t=0x2d7 v=86/19/85/20   four entries: the modes the appliance supports. 22 is NOT
 *                              among them, though state frames list it in the same triple.
 *      ... 30 further tags, meaning unknown
 * NOTE it carries no 0x1f7, which is what keeps isValuesResponse() from accepting it.
 */
const CAPS_RESPONSE_HEX =
    '000004000000a7020170797d208400644fb01024b070180000a5f0180000b0b00751d4b300b340b4e0' +
    '0100b5b0080002f850ffb541b6a00dbeb6e00946b7200200b750a0bc40b3c0bd30010001bd60081fbd' +
    '85b9501eb99046d41081dd04fa01fb0bbc201c00abc4b5d056b600b648b5d013b600b642b5d055b600' +
    'b647b5d014b600b64895c1'

/*
 * The comprehensive dump, 125 bytes / 47 TLVs, captured as the appliance's answer to
 * VALUES_REQUEST_HEX. Contains 0x1f7, so isValuesResponse() accepts it.
 *      t=0x1f7 v=0     power off (auto-dry was running at the time)
 *      t=0x1f9 v=86    mode 스마트플러스
 *      t=0x1fa v=8     fan auto
 *      t=0x253 v=55    target humidity 55 %
 *      t=0x1fd v=52    temperature raw, 26.0 C under the inherited scale
 *      t=0x336 v=61    room humidity 61 %
 *      t=0x225 v=36    auto-dry, 36 minutes left
 *      t=0x20e v=253   auto-dry setting 스마트 건조
 *      t=0x189 v=3     airflow 상하회전
 *      ... plus the unmapped tags listed in the profile's class comment
 */
const VALUES_RESPONSE_HEX =
    '000004000000a7020499707dc07e50567e8894d0377f503486c087008980c900d80087806150' +
    '78cd903d8840ce80ab00a88187c0e800ee4461808950248390fdea406243f8008c808cc0b5d0' +
    '56b600b648b5d013b600b642b5d055b600b647b5d014b600b648b5d016b600b6485cf0561413' +
    '5d301500fffa80cdc1bb0e'

/* --- state frames, one per named owner action ------------------------------------- */

/* 전원 끄기. Carries the auto-dry that the power-off started: 0x225 = 50 minutes. */
const STATE_POWER_OFF_HEX = '000004000000a7020477077dc0d800895032c487'
/* 전원 켜기 */
const STATE_POWER_ON_HEX = '000004000000a702047a0a7dc1d80189408c808cc0fec1'

/* 저소음 제습 (0x1f9 = 19), and the fan the appliance applied with it */
const STATE_MODE_QUIET_HEX = '000004000000a702047c1a7e50137e82b5d056b600b642b5d014b600b642b5d016b600b642b91a'
/* 쾌속의류 (0x1f9 = 85) */
const STATE_MODE_FAST_LAUNDRY_HEX = '000004000000a702047e1c7e50557e876243b5d056b600b647b5d014b600b647b5d016b600b6471271'
/* 집중건조 (0x1f9 = 20) */
const STATE_MODE_FOCUSED_DRY_HEX = '000004000000a702047f1a7e50147e86b5d056b600b646b5d014b600b646b5d016b600b64622b5'
/* 스마트플러스 (0x1f9 = 86) */
const STATE_MODE_SMART_PLUS_HEX = '000004000000a70204811c7e50567e886241b5d056b600b648b5d014b600b648b5d016b600b6480a9e'

/* 풍량 약풍 (0x1fa = 2) and 자동 (0x1fa = 8) */
const STATE_FAN_LOW_HEX = '000004000000a7020483177e82b5d056b600b642b5d014b600b642b5d016b600b64226e5'
const STATE_FAN_AUTO_HEX = '000004000000a702048e177e88b5d056b600b648b5d014b600b648b5d016b600b648b7fb'

/* 습도 내림 -> 50 %, 습도 올림 -> 55 % */
const STATE_TARGET_50_HEX = '000004000000a70204940394d032b9f8'
const STATE_TARGET_55_HEX = '000004000000a70204950394d037430c'

/* 바람방향 공간 (0x189 = 0) and 상하회전 (0x189 = 3) */
const STATE_AIRFLOW_SPACE_HEX = '000004000000a702049802624087fa'
const STATE_AIRFLOW_SWING_HEX = '000004000000a702049c0262437d68'

/* 자동건조 사용안함 / 10분 / 스마트건조 */
const STATE_AUTODRY_OFF_HEX = '000004000000a70204a1028380a2ab'
const STATE_AUTODRY_10MIN_HEX = '000004000000a70204a4057f5036838237e4'
const STATE_AUTODRY_SMART_HEX = '000004000000a70204a8038390fddda1'

/* UV nano 꺼짐 / 켜짐 */
const STATE_UVNANO_OFF_HEX = '000004000000a70204aa02a88066a8'
const STATE_UVNANO_ON_HEX = '000004000000a70204ab02a881003d'

/* 잠금 켜짐 / 꺼짐 */
const STATE_CHILDLOCK_ON_HEX = '000004000000a70204ac07ea418c808cd01c1327'
const STATE_CHILDLOCK_OFF_HEX = '000004000000a70204af02ea40680f'

/* 제품 버튼음 꺼짐 (0x3a0 = 1) / 켜짐 (0x3a0 = 0) - inverted */
const STATE_BEEP_OFF_HEX = '000004000000a70204b202e80174a9'
const STATE_BEEP_ON_HEX = '000004000000a70204b602e800ae79'

/* 제품 상태 표시부 꺼짐 (0x21f = 1) / 켜짐 (0x21f = 0) - inverted */
const STATE_DISPLAY_OFF_HEX = '000004000000a70204b70287c10ab4'
const STATE_DISPLAY_ON_HEX = '000004000000a70204ba0287c02313'

/* 습도센서 운전중에만 표시 (0x337 = 0) / 항상 표시 (0x337 = 1) */
const STATE_HUMIDITY_DISPLAY_RUNNING_HEX = '000004000000a70204bd02cdc09039'
const STATE_HUMIDITY_DISPLAY_ALWAYS_HEX = '000004000000a70204bf02cdc16d70'

/*
 * The two private-channel writes the LG app sent for that setting, captured byte for byte
 * (2026-07-31): cmd 0x0c, cmd_sub 0x01, 4-byte payload. sendPrivWrite() has to reproduce
 * these exactly - including the 01 02 prefix, which is NOT the 00 ff that
 * TLVDevice.sendPrivCommand() hardcodes.
 */
const APP_PRIV_WRITE_HUMIDITY_DISPLAY_RUNNING_HEX = '01020400000065fd0100050c00000000b161'
const APP_PRIV_WRITE_HUMIDITY_DISPLAY_ALWAYS_HEX = '01020400000065fd0100050c00000001a140'

/*
 * 자동건조 중단, captured from the app on 2026-07-31: a write of the remaining-minutes tag
 * to zero, after which the appliance reported 0x225: 29 -> 0.
 */
const APP_WRITE_AUTODRY_CANCEL_HEX = '010104000000650201000289403d4f'

/* 물통 조명: 켬 / 끔 (0x21e), 색상 0x3e0 = 1 마린블루 .. 7 마젠타핑크, 밝기 0x185 */
const STATE_TANKLIGHT_ON_HEX = '000004000000a70204f70287812cec'
const STATE_TANKLIGHT_OFF_HEX = '000004000000a702040c028780bd9f'
const STATE_TANKLIGHT_COLOUR_MARINE_HEX = '000004000000a70204f902f8010759'
const STATE_TANKLIGHT_COLOUR_MAGENTA_HEX = '000004000000a702040402f807c154'
/* 40 % and 100 %: the appliance stores 100 + percent */
const STATE_TANKLIGHT_BRIGHT_40_HEX = '000004000000a70204050361508c600c'
const STATE_TANKLIGHT_BRIGHT_100_HEX = '000004000000a702040a036150c80db5'

/* 예약 1시간 -> the appliance echoes 59, already counting down. And 6 시간 -> 359. */
const STATE_TIMER_59_HEX = '000004000000a702040a0386d03becf0'
const STATE_TIMER_359_HEX = '000004000000a70204110a86e001678c90188cd0131f0b'

/* room humidity 61 %, and the temperature reading 54 (27.0 C under the inherited scale) */
const STATE_HUMIDITY_61_HEX = '000004000000a702046d03cd903d12ae'
const STATE_TEMPERATURE_54_HEX = '000004000000a702047b037f5036ecd1'

/*
 * Two frames this profile must NOT decode. Both share the appliance's envelope and both
 * parse as TLV without throwing - that is exactly why they are here. Their payloads are not
 * TLV: reading them as such yields tag 0x0 repeated and values like 16777215.
 */
const TELEMETRY_A8_HEX =
    '000004000000a8661001540a0324106701563708000000000101010000fd0100010100000700000000' +
    '000078000000000000080a0002e00a000013d4029e029e0258363e00fa000000000000000000000004' +
    '62006b0118320832324199d1b918f3'
const PRIVATE_87FD_HEX =
    '00000400000087fd0300b1153500000058020000ffffffffffffffffffffffffffffffffffffffffff' +
    'ffffffffffffff0e00000038000000ffffffff3e000000ffffffffffffffffffffffffffffffffffff' +
    'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff0000000048000000e65045' +
    'ff703e37179908eb00eb0000000000000000000000000000000000000000000000000000000000000000' +
    '0000000000000000000000000000000000000000000000008067'

/*
 * SYNTHETIC - built here, not captured, and the only frames in this file that are.
 *
 * The appliance was never recorded reporting a mode or an auto-dry setting outside the four
 * and five this profile lists. These two exist to pin the behaviour that matters when it
 * does: an unlisted raw value must publish NOTHING rather than being forced onto a
 * neighbouring label. Built with the repo's own TLV encoder and crc16, in the state-frame
 * shape (buf[6] = 0xa7, buf[7] = 0x02, buf[8] = 0x04).
 *
 * 0x1f9 = 22 is not an arbitrary choice: it is the fifth mode value the appliance lists in
 * its own (0x2d7, 0x2d8, 0x2d9) triple table and does not offer in the app. Writing it to the
 * live appliance was ACKed but never echoed back as 0x1f9, and the capability reply omits it.
 */
function synthState(tlv: TLV.TLV[]): string {
    const payload = TLV.build(tlv)
    const body = [0x04, 0x00, 0x00, 0x00, 0xa7, 0x02, 0x04, 0x00, payload.length].concat(payload)
    const crc = crc16(body)
    return hex(Buffer.from([0x00, 0x00].concat(body, [crc >> 8, crc & 0xff])))
}
const STATE_MODE_UNKNOWN_22_HEX = synthState([{ t: 0x1f9, v: 22 }])
const STATE_AUTODRY_UNKNOWN_1_HEX = synthState([{ t: 0x20e, v: 1 }])

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    ha.on('setProperty', (id: string, prop: string, value: string) => {
        dev.setProperty(prop, value)
    })
    return { ha, thinq, dev }
}

/** A device with capabilities and values applied, and the send recorder cleared. */
function readyDevice(t: import('node:test').TestContext) {
    enableMockTimers(t)
    const { ha, thinq, dev } = makeDevice()
    thinq.emit('data', buf(CAPS_RESPONSE_HEX))
    thinq.emit('data', buf(VALUES_RESPONSE_HEX))
    thinq.resetRecorder()
    return { ha, thinq, dev }
}

/**
 * Writes are collected for WRITE_COALESCE_MS before they go out as one frame, so a test that
 * sets a property has to let that window pass before looking at the outbox.
 */
function flushWrites(t: import('node:test').TestContext) {
    tickMockTimers(t, 200)
}

/** The TLVs of the last frame the profile sent to the appliance. */
function lastSentTLV(thinq: MockThinq2Device) {
    const frame = thinq.outbox[thinq.outbox.length - 1]
    assert.ok(frame, 'a frame was sent')
    return TLV.parse(frame.subarray(11, 11 + frame[10]))
}

describe(MODEL_ID, () => {
    test('constructor publishes the full config without waiting for capabilities', (t) => {
        enableMockTimers(t)
        const { ha } = makeDevice()

        const device = ha.devices[DEVICE_ID]
        assert.ok(device, 'HA configuration published')
        assert.equal(device.availability, 'online')

        const components = device.config!.components as Record<string, Record<string, unknown>>

        assert.equal(components.humidifier.platform, 'humidifier')
        assert.equal(components.humidifier.device_class, 'dehumidifier')
        /* the four the appliance offers in the app and declares in its capability reply */
        assert.deepEqual(components.humidifier.modes, ['smart plus', 'quiet', 'fast laundry', 'focused dry'])
        /* 0x2e5 / 0x2e6 from the capability reply */
        assert.equal(components.humidifier.min_humidity, 30)
        assert.equal(components.humidifier.max_humidity, 70)

        for (const name of ['uvnano', 'childlock', 'beep', 'display']) {
            assert.equal(components[name]?.platform, 'switch', `${name} switch`)
            assert.equal(components[name]?.entity_category, 'config', `${name} is config`)
        }

        for (const name of ['fanspeed', 'airflow', 'autodry']) {
            assert.equal(components[name]?.platform, 'select', `${name} select`)
        }
        /* everyday controls, so no entity_category at all - HA files them under Controls */
        assert.ok(!components.fanspeed?.entity_category, 'fan speed is a control')
        assert.ok(!components.airflow?.entity_category, 'airflow is a control')
        /* auto-dry sits under Diagnostic, at the owner's request */
        assert.equal(components.autodry?.entity_category, 'diagnostic')
        assert.deepEqual(components.fanspeed.options, ['low', 'medium', 'high', 'turbo', 'auto'])
        assert.deepEqual(components.airflow.options, ['space', 'multi', 'focus', 'swing'])
        assert.deepEqual(components.autodry.options, ['off', '10 min', '30 min', '60 min', 'smart'])

        assert.equal(components.offtimer?.platform, 'number')
        assert.equal(components.offtimer?.unit_of_measurement, 'h')
        assert.equal(components.offtimer?.max, 8)
        /* the app moves the reservation in whole hours */
        assert.equal(components.offtimer?.step, 1)

        /* the room humidity is a measurement, not diagnostics, and shares the humidifier's topic */
        assert.equal(components.humidity?.platform, 'sensor')
        assert.equal(components.humidity?.device_class, 'humidity')
        assert.equal(components.humidity?.unit_of_measurement, '%')
        assert.ok(!components.humidity?.entity_category, 'humidity is not diagnostic')
        assert.equal(components.humidity?.state_topic, components.humidifier.current_humidity_topic)

        for (const name of ['autodry_remaining', 'error']) {
            assert.equal(components[name]?.platform, 'sensor', `${name} sensor`)
            assert.equal(components[name]?.entity_category, 'diagnostic', `${name} is diagnostic`)
        }

        /* writable, but over the private channel - see the write test */
        assert.equal(components.humidity_display?.platform, 'select')
        assert.equal(components.humidity_display?.entity_category, 'diagnostic')
        assert.deepEqual(components.humidity_display?.options, ['while running', 'always'])

        /* a room reading, so it belongs beside the humidity under "Sensors" */
        assert.equal(components.temperature?.platform, 'sensor')
        assert.equal(components.temperature?.device_class, 'temperature')
        assert.ok(!components.temperature?.entity_category, 'temperature is not diagnostic')

        /* "is auto-dry running", derived from the remaining minutes */
        assert.equal(components.autodry_running?.platform, 'binary_sensor')
        assert.equal(components.autodry_running?.device_class, 'running')

        /*
         * The two mode-dependent entities carry their own availability topic PLUS both
         * device-wide ones - a component's list replaces the device's rather than extending it.
         */
        for (const name of ['fanspeed', 'airflow']) {
            assert.deepEqual(
                components[name]?.availability,
                [
                    { topic: '$this/availability' },
                    { topic: '$rethink/availability' },
                    { topic: `$this/${name}-availability` },
                ],
                `${name} availability`,
            )
            assert.equal(components[name]?.availability_mode, 'all')
        }

        /* the water tank has no tag yet - see the profile. Guard against a silent invention. */
        assert.ok(!components.watertank, 'no water tank entity until a frame identifies it')
    })

    test('constructor asks for capabilities, and stops once they arrive', (t) => {
        enableMockTimers(t)
        const { thinq } = makeDevice()

        assert.equal(hex(thinq.outbox[0]), CAPS_REQUEST_HEX, 'capability query sent on construction')

        /* without an answer it retries every 15 s */
        thinq.resetRecorder()
        tickMockTimers(t, 15_000)
        assert.equal(hex(thinq.outbox[0]), CAPS_REQUEST_HEX, 'capability query retried')

        /* the real reply carries 0x2da, which is what isCapsResponse() keys on */
        thinq.resetRecorder()
        thinq.emit('data', buf(CAPS_RESPONSE_HEX))
        assert.equal(hex(thinq.outbox[0]), VALUES_REQUEST_HEX, 'values query follows capabilities')

        thinq.resetRecorder()
        tickMockTimers(t, 15_000)
        assert.ok(
            !thinq.outbox.some((f) => hex(f) === CAPS_REQUEST_HEX),
            'capability query is not retried after the reply',
        )
    })

    test('the values dump ends the values retry loop', (t) => {
        enableMockTimers(t)
        const { thinq } = makeDevice()
        thinq.emit('data', buf(CAPS_RESPONSE_HEX))

        /* unanswered, the values query repeats every 15 s */
        thinq.resetRecorder()
        tickMockTimers(t, 15_000)
        assert.equal(hex(thinq.outbox[0]), VALUES_REQUEST_HEX, 'values query retried')

        thinq.emit('data', buf(VALUES_RESPONSE_HEX))
        thinq.resetRecorder()
        tickMockTimers(t, 15_000)
        assert.equal(thinq.outbox.length, 0, 'values query stops once the dump arrives')
    })

    test('the values dump publishes every mapped reading', (t) => {
        const { ha } = readyDevice(t)

        assert.equal(ha.getProperty(DEVICE_ID, 'humidifier', 'state'), 'OFF')
        assert.equal(ha.getProperty(DEVICE_ID, 'humidifier', 'mode_state'), 'smart plus')
        assert.equal(ha.getProperty(DEVICE_ID, 'humidifier', 'target_humidity_state'), 55)
        assert.equal(ha.getProperty(DEVICE_ID, 'humidifier', 'current_humidity'), 61)
        assert.equal(ha.getProperty(DEVICE_ID, 'fanspeed', 'state'), 'auto')
        assert.equal(ha.getProperty(DEVICE_ID, 'airflow', 'state'), 'swing')
        assert.equal(ha.getProperty(DEVICE_ID, 'autodry', 'state'), 'smart')
        assert.equal(ha.getProperty(DEVICE_ID, 'autodry_remaining', 'state'), 36)
        assert.equal(ha.getProperty(DEVICE_ID, 'uvnano', 'state'), 'ON')
        assert.equal(ha.getProperty(DEVICE_ID, 'childlock', 'state'), 'OFF')
        assert.equal(ha.getProperty(DEVICE_ID, 'beep', 'state'), 'ON')
        assert.equal(ha.getProperty(DEVICE_ID, 'display', 'state'), 'ON')
        assert.equal(ha.getProperty(DEVICE_ID, 'humidity_display', 'state'), 'always')
        assert.equal(ha.getProperty(DEVICE_ID, 'error', 'state'), 0)
        /* 0x1fd = 52 under the scale inherited from the AC profiles */
        assert.equal(ha.getProperty(DEVICE_ID, 'temperature', 'state'), 26)
    })

    test('power and mode follow the appliance', (t) => {
        const { ha, thinq } = readyDevice(t)

        thinq.emit('data', buf(STATE_POWER_ON_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'humidifier', 'state'), 'ON')
        /* the same frame carries the auto-dry countdown reset */
        assert.equal(ha.getProperty(DEVICE_ID, 'autodry_remaining', 'state'), 0)

        thinq.emit('data', buf(STATE_POWER_OFF_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'humidifier', 'state'), 'OFF')
        /* switching off with auto-dry armed starts a 50 minute run */
        assert.equal(ha.getProperty(DEVICE_ID, 'autodry_remaining', 'state'), 50)

        for (const [frame, mode, fan] of [
            [STATE_MODE_QUIET_HEX, 'quiet', 'low'],
            [STATE_MODE_FAST_LAUNDRY_HEX, 'fast laundry', 'turbo'],
            [STATE_MODE_FOCUSED_DRY_HEX, 'focused dry', 'high'],
            [STATE_MODE_SMART_PLUS_HEX, 'smart plus', 'auto'],
        ] as const) {
            thinq.emit('data', buf(frame))
            assert.equal(ha.getProperty(DEVICE_ID, 'humidifier', 'mode_state'), mode)
            /* every mode change carries the fan the appliance remembers for that mode */
            assert.equal(ha.getProperty(DEVICE_ID, 'fanspeed', 'state'), fan, `${mode} fan`)
        }
    })

    test('auto-dry running is derived from the remaining minutes', (t) => {
        const { ha, thinq } = readyDevice(t)

        /* the values dump had 36 minutes left, so it is running - while the appliance reads OFF */
        assert.equal(ha.devices[DEVICE_ID].properties['autodry_running'], 'ON')
        assert.equal(ha.getProperty(DEVICE_ID, 'humidifier', 'state'), 'OFF')

        /* switching on ends the run: the same frame carries 0x225 = 0 */
        thinq.emit('data', buf(STATE_POWER_ON_HEX))
        assert.equal(ha.devices[DEVICE_ID].properties['autodry_running'], 'OFF')

        /* switching off with auto-dry armed starts it again, 50 minutes */
        thinq.emit('data', buf(STATE_POWER_OFF_HEX))
        assert.equal(ha.devices[DEVICE_ID].properties['autodry_running'], 'ON')
        assert.equal(ha.getProperty(DEVICE_ID, 'autodry_remaining', 'state'), 50)
    })

    test('the mode that locks the controls also refuses a target humidity write', (t) => {
        const { ha, thinq } = readyDevice(t)

        /* the values dump left the appliance at 55 % */
        assert.equal(ha.getProperty(DEVICE_ID, 'humidifier', 'target_humidity_state'), 55)

        thinq.emit('data', buf(STATE_MODE_FOCUSED_DRY_HEX))
        thinq.resetRecorder()
        ha.setProperty(DEVICE_ID, 'humidifier', 'target_humidity_command', '45')

        /* the appliance would ACK it and do nothing, so nothing is sent... */
        assert.equal(thinq.outbox.length, 0, 'no frame sent in the locked mode')
        /* ...and HA is told again what the appliance actually holds */
        assert.equal(ha.getProperty(DEVICE_ID, 'humidifier', 'target_humidity_state'), 55)

        /* in any other mode it goes through */
        thinq.emit('data', buf(STATE_MODE_SMART_PLUS_HEX))
        ha.setProperty(DEVICE_ID, 'humidifier', 'target_humidity_command', '45')
        flushWrites(t)
        assert.deepEqual(lastSentTLV(thinq), [{ t: 0x253, l: 1, v: 45 }])
    })

    test('the auto-dry cancel button sends the frame the app sends', (t) => {
        const { ha, thinq } = readyDevice(t)
        const components = ha.devices[DEVICE_ID].config!.components as Record<string, Record<string, unknown>>

        assert.equal(components.autodry_cancel?.platform, 'button')

        ha.emit('setProperty', DEVICE_ID, 'autodry_cancel', 'PRESS')
        flushWrites(t)
        /*
         * Compared as TLV, not as bytes: the app's own frame (APP_WRITE_AUTODRY_CANCEL_HEX)
         * carries byte7 = 0 and everything rethink sends carries byte7 = 1, which is the
         * sequence byte every profile in this repo already differs on.
         */
        assert.deepEqual(lastSentTLV(thinq), [{ t: 0x225, l: 0, v: 0 }])
        assert.deepEqual(
            TLV.parse(buf(APP_WRITE_AUTODRY_CANCEL_HEX).subarray(11, 13)),
            lastSentTLV(thinq),
            'same TLV as the app sent',
        )

        /* the setting itself is untouched: only the run stops */
        assert.equal(ha.getProperty(DEVICE_ID, 'autodry', 'state'), 'smart')
    })

    test('the fan controls go unavailable in the mode that drives the fan itself', (t) => {
        const { ha, thinq } = readyDevice(t)
        const availability = (name: string) => ha.devices[DEVICE_ID].properties[`${name}-availability`]

        /* the values dump had mode 86 - both selectable */
        assert.equal(availability('fanspeed'), 'online')
        assert.equal(availability('airflow'), 'online')

        /* 집중건조 (0x1f9 = 20): the app offers neither, so HA greys both out */
        thinq.emit('data', buf(STATE_MODE_FOCUSED_DRY_HEX))
        assert.equal(availability('fanspeed'), 'offline')
        assert.equal(availability('airflow'), 'offline')

        /* and back */
        thinq.emit('data', buf(STATE_MODE_SMART_PLUS_HEX))
        assert.equal(availability('fanspeed'), 'online')
        assert.equal(availability('airflow'), 'online')

        /* the mode itself still publishes normally through the same callback */
        assert.equal(ha.getProperty(DEVICE_ID, 'humidifier', 'mode_state'), 'smart plus')
    })

    test('availability is published before the appliance has said anything', (t) => {
        enableMockTimers(t)
        const { ha } = makeDevice()

        /*
         * An MQTT entity whose availability topic has never been published reads as
         * unavailable, so the constructor must not wait for the first mode frame.
         */
        assert.equal(ha.devices[DEVICE_ID].properties['fanspeed-availability'], 'online')
        assert.equal(ha.devices[DEVICE_ID].properties['airflow-availability'], 'online')
    })

    test('an unlisted raw value publishes nothing', (t) => {
        const { ha, thinq } = readyDevice(t)

        thinq.emit('data', buf(STATE_MODE_SMART_PLUS_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'humidifier', 'mode_state'), 'smart plus')

        /* mode 22: acked by the appliance, absent from its capability reply, unnamed */
        thinq.emit('data', buf(STATE_MODE_UNKNOWN_22_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'humidifier', 'mode_state'), 'smart plus', 'mode 22 not published')

        thinq.emit('data', buf(STATE_AUTODRY_SMART_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'autodry', 'state'), 'smart')
        thinq.emit('data', buf(STATE_AUTODRY_UNKNOWN_1_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'autodry', 'state'), 'smart', 'auto-dry 1 not published')
    })

    test('fan, airflow, target humidity and auto-dry follow the appliance', (t) => {
        const { ha, thinq } = readyDevice(t)

        thinq.emit('data', buf(STATE_FAN_LOW_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'fanspeed', 'state'), 'low')
        thinq.emit('data', buf(STATE_FAN_AUTO_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'fanspeed', 'state'), 'auto')

        thinq.emit('data', buf(STATE_AIRFLOW_SPACE_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'airflow', 'state'), 'space')
        thinq.emit('data', buf(STATE_AIRFLOW_SWING_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'airflow', 'state'), 'swing')

        thinq.emit('data', buf(STATE_TARGET_50_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'humidifier', 'target_humidity_state'), 50)
        thinq.emit('data', buf(STATE_TARGET_55_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'humidifier', 'target_humidity_state'), 55)

        thinq.emit('data', buf(STATE_AUTODRY_OFF_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'autodry', 'state'), 'off')
        thinq.emit('data', buf(STATE_AUTODRY_10MIN_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'autodry', 'state'), '10 min')
    })

    test('beep and display read inverted, as measured', (t) => {
        const { ha, thinq } = readyDevice(t)

        /* the owner turned the beep OFF and the app wrote 0x3a0 = 1 */
        thinq.emit('data', buf(STATE_BEEP_OFF_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'beep', 'state'), 'OFF')
        thinq.emit('data', buf(STATE_BEEP_ON_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'beep', 'state'), 'ON')

        thinq.emit('data', buf(STATE_DISPLAY_OFF_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'display', 'state'), 'OFF')
        thinq.emit('data', buf(STATE_DISPLAY_ON_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'display', 'state'), 'ON')
    })

    test('uvnano, child lock and the panel humidity display follow the appliance', (t) => {
        const { ha, thinq } = readyDevice(t)

        thinq.emit('data', buf(STATE_UVNANO_OFF_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'uvnano', 'state'), 'OFF')
        thinq.emit('data', buf(STATE_UVNANO_ON_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'uvnano', 'state'), 'ON')

        thinq.emit('data', buf(STATE_CHILDLOCK_ON_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'childlock', 'state'), 'ON')
        thinq.emit('data', buf(STATE_CHILDLOCK_OFF_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'childlock', 'state'), 'OFF')

        thinq.emit('data', buf(STATE_HUMIDITY_DISPLAY_RUNNING_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'humidity_display', 'state'), 'while running')
        thinq.emit('data', buf(STATE_HUMIDITY_DISPLAY_ALWAYS_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'humidity_display', 'state'), 'always')
    })

    test('the reservation is minutes on the wire and hours in HA, rounded up', (t) => {
        const { ha, thinq } = readyDevice(t)

        /* the owner set 1 h; the appliance answered 59, already counting down */
        thinq.emit('data', buf(STATE_TIMER_59_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'offtimer', 'state'), 1)

        /* 6 h -> 359 minutes left is still more than 5.75 h */
        thinq.emit('data', buf(STATE_TIMER_359_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'offtimer', 'state'), 6)
    })

    test('room humidity and temperature publish as measurements', (t) => {
        const { ha, thinq } = readyDevice(t)

        thinq.emit('data', buf(STATE_HUMIDITY_61_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'humidifier', 'current_humidity'), 61)

        /* raw 54 -> 27.0 C under the scale inherited from the AC profiles */
        thinq.emit('data', buf(STATE_TEMPERATURE_54_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'temperature', 'state'), 27)
    })

    test('HA writes reach the appliance as single TLVs', (t) => {
        const { ha, thinq } = readyDevice(t)

        /* power: a BARE 0x1f7, which is what the LG app was captured sending */
        ha.setProperty(DEVICE_ID, 'humidifier', 'command', 'ON')
        flushWrites(t)
        assert.deepEqual(lastSentTLV(thinq), [{ t: 0x1f7, l: 0, v: 1 }])
        ha.setProperty(DEVICE_ID, 'humidifier', 'command', 'OFF')
        flushWrites(t)
        assert.deepEqual(lastSentTLV(thinq), [{ t: 0x1f7, l: 0, v: 0 }])

        ha.setProperty(DEVICE_ID, 'humidifier', 'mode_command', 'quiet')

        flushWrites(t)
        assert.deepEqual(lastSentTLV(thinq), [{ t: 0x1f9, l: 1, v: 19 }])
        ha.setProperty(DEVICE_ID, 'humidifier', 'mode_command', 'fast laundry')
        flushWrites(t)
        assert.deepEqual(lastSentTLV(thinq), [{ t: 0x1f9, l: 1, v: 85 }])

        ha.setProperty(DEVICE_ID, 'humidifier', 'target_humidity_command', '50')

        flushWrites(t)
        assert.deepEqual(lastSentTLV(thinq), [{ t: 0x253, l: 1, v: 50 }])

        ha.setProperty(DEVICE_ID, 'fanspeed', 'command', 'turbo')

        flushWrites(t)
        assert.deepEqual(lastSentTLV(thinq), [{ t: 0x1fa, l: 0, v: 7 }])

        ha.setProperty(DEVICE_ID, 'airflow', 'command', 'focus')

        flushWrites(t)
        assert.deepEqual(lastSentTLV(thinq), [{ t: 0x189, l: 0, v: 2 }])

        ha.setProperty(DEVICE_ID, 'autodry', 'command', 'smart')

        flushWrites(t)
        assert.deepEqual(lastSentTLV(thinq), [{ t: 0x20e, l: 1, v: 253 }])

        /* inverted: HA 'OFF' writes 1 */
        ha.setProperty(DEVICE_ID, 'beep', 'command', 'OFF')
        flushWrites(t)
        assert.deepEqual(lastSentTLV(thinq), [{ t: 0x3a0, l: 0, v: 1 }])
        ha.setProperty(DEVICE_ID, 'display', 'command', 'ON')
        flushWrites(t)
        assert.deepEqual(lastSentTLV(thinq), [{ t: 0x21f, l: 0, v: 0 }])

        ha.setProperty(DEVICE_ID, 'uvnano', 'command', 'ON')

        flushWrites(t)
        assert.deepEqual(lastSentTLV(thinq), [{ t: 0x2a2, l: 0, v: 1 }])
        ha.setProperty(DEVICE_ID, 'childlock', 'command', 'ON')
        flushWrites(t)
        assert.deepEqual(lastSentTLV(thinq), [{ t: 0x3a9, l: 0, v: 1 }])

        /* hours in HA, minutes on the wire */
        ha.setProperty(DEVICE_ID, 'offtimer', 'command', '8')
        flushWrites(t)
        assert.deepEqual(lastSentTLV(thinq), [{ t: 0x21b, l: 2, v: 480 }])
    })

    test('an unknown label cancels the write instead of sending a bogus value', (t) => {
        const { ha, thinq } = readyDevice(t)

        ha.setProperty(DEVICE_ID, 'fanspeed', 'command', 'very high')

        flushWrites(t)
        assert.equal(thinq.outbox.length, 0, 'nothing sent for a label this appliance has no value for')
    })

    test('the panel humidity display is written over the private channel, not with a TLV', (t) => {
        const { ha, thinq } = readyDevice(t)

        ha.setProperty(DEVICE_ID, 'humidity_display', 'command', 'while running')

        flushWrites(t)
        assert.equal(thinq.outbox.length, 1, 'exactly one frame - no TLV write follows the private one')
        assert.equal(
            hex(thinq.outbox[0]),
            APP_PRIV_WRITE_HUMIDITY_DISPLAY_RUNNING_HEX.toUpperCase(),
            'byte-for-byte the frame the LG app sent',
        )

        thinq.resetRecorder()
        ha.setProperty(DEVICE_ID, 'humidity_display', 'command', 'always')
        flushWrites(t)
        assert.equal(hex(thinq.outbox[0]), APP_PRIV_WRITE_HUMIDITY_DISPLAY_ALWAYS_HEX.toUpperCase())

        /* and the entity only moves when the appliance says so */
        thinq.emit('data', buf(STATE_HUMIDITY_DISPLAY_RUNNING_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'humidity_display', 'state'), 'while running')
    })

    test('the tank light reads on/off, brightness and colour', (t) => {
        const { ha, thinq } = readyDevice(t)
        const components = ha.devices[DEVICE_ID].config!.components as Record<string, Record<string, unknown>>

        assert.equal(components.tanklight?.platform, 'light')
        assert.equal(components.tanklight?.entity_category, 'config')
        assert.equal(components.tanklight?.brightness_scale, 100)
        assert.deepEqual(components.tanklight?.effect_list, [
            'white',
            'marine blue',
            'lawn green',
            'salmon pink',
            'lavender',
            'sky',
            'sunlight',
            'magenta pink',
        ])

        thinq.emit('data', buf(STATE_TANKLIGHT_ON_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'tanklight', 'state'), 'ON')
        thinq.emit('data', buf(STATE_TANKLIGHT_OFF_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'tanklight', 'state'), 'OFF')

        thinq.emit('data', buf(STATE_TANKLIGHT_COLOUR_MARINE_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'tanklight', 'effect_state'), 'marine blue')
        thinq.emit('data', buf(STATE_TANKLIGHT_COLOUR_MAGENTA_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'tanklight', 'effect_state'), 'magenta pink')

        /* raw 140 is 40 %, raw 200 is 100 % */
        thinq.emit('data', buf(STATE_TANKLIGHT_BRIGHT_40_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'tanklight', 'brightness_state'), 40)
        thinq.emit('data', buf(STATE_TANKLIGHT_BRIGHT_100_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'tanklight', 'brightness_state'), 100)
    })

    test('the tank light writes on/off, brightness and colour', (t) => {
        const { ha, thinq } = readyDevice(t)

        ha.setProperty(DEVICE_ID, 'tanklight', 'command', 'ON')

        flushWrites(t)
        assert.deepEqual(lastSentTLV(thinq), [{ t: 0x21e, l: 0, v: 1 }])
        ha.setProperty(DEVICE_ID, 'tanklight', 'command', 'OFF')
        flushWrites(t)
        assert.deepEqual(lastSentTLV(thinq), [{ t: 0x21e, l: 0, v: 0 }])

        /* HA sends a percentage; the appliance wants 100 + percent */
        ha.setProperty(DEVICE_ID, 'tanklight', 'brightness_command', '60')
        flushWrites(t)
        assert.deepEqual(lastSentTLV(thinq), [{ t: 0x185, l: 1, v: 160 }])

        /* anything in between snaps to the app's 20 % step */
        ha.setProperty(DEVICE_ID, 'tanklight', 'brightness_command', '55')
        flushWrites(t)
        assert.deepEqual(lastSentTLV(thinq), [{ t: 0x185, l: 1, v: 160 }])
        ha.setProperty(DEVICE_ID, 'tanklight', 'brightness_command', '71')
        flushWrites(t)
        assert.deepEqual(lastSentTLV(thinq), [{ t: 0x185, l: 1, v: 180 }])
        ha.setProperty(DEVICE_ID, 'tanklight', 'brightness_command', '250')
        flushWrites(t)
        assert.deepEqual(lastSentTLV(thinq), [{ t: 0x185, l: 1, v: 200 }], 'clamped to 100 %')

        /* 0 % is not a brightness the appliance has - it means "off" */
        ha.setProperty(DEVICE_ID, 'tanklight', 'brightness_command', '0')
        flushWrites(t)
        assert.deepEqual(lastSentTLV(thinq), [{ t: 0x21e, l: 0, v: 0 }], 'switches the light off')
        ha.setProperty(DEVICE_ID, 'tanklight', 'brightness_command', '9')
        flushWrites(t)
        assert.deepEqual(lastSentTLV(thinq), [{ t: 0x21e, l: 0, v: 0 }], 'rounds down to off')

        ha.setProperty(DEVICE_ID, 'tanklight', 'effect_command', 'lavender')

        flushWrites(t)
        assert.deepEqual(lastSentTLV(thinq), [{ t: 0x3e0, l: 0, v: 4 }])

        thinq.resetRecorder()
        ha.setProperty(DEVICE_ID, 'tanklight', 'effect_command', 'chartreuse')
        flushWrites(t)
        assert.equal(thinq.outbox.length, 0, 'a colour this appliance has no value for is not sent')
    })

    test('the colour is also published and accepted as RGB', (t) => {
        const { ha, thinq } = readyDevice(t)

        /* reading: the appliance sends an index, and both views follow it */
        thinq.emit('data', buf(STATE_TANKLIGHT_COLOUR_MAGENTA_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'tanklight', 'effect_state'), 'magenta pink')
        assert.equal(ha.devices[DEVICE_ID].properties['tanklight-rgb'], '255,189,246')

        thinq.emit('data', buf(STATE_TANKLIGHT_COLOUR_MARINE_HEX))
        assert.equal(ha.devices[DEVICE_ID].properties['tanklight-rgb'], '154,173,251')

        /* writing: an exact preset goes through as itself */
        ha.setProperty(DEVICE_ID, 'tanklight', 'rgb_command', '255,255,255')
        flushWrites(t)
        assert.deepEqual(lastSentTLV(thinq), [{ t: 0x3e0, l: 0, v: 0 }], 'white')

        /* and anything else snaps to the nearest of the eight the appliance has */
        ha.setProperty(DEVICE_ID, 'tanklight', 'rgb_command', '255,190,240')
        flushWrites(t)
        assert.deepEqual(lastSentTLV(thinq), [{ t: 0x3e0, l: 0, v: 7 }], 'nearest is magenta pink')
        ha.setProperty(DEVICE_ID, 'tanklight', 'rgb_command', '180,235,250')
        flushWrites(t)
        assert.deepEqual(lastSentTLV(thinq), [{ t: 0x3e0, l: 0, v: 5 }], 'nearest is sky')

        thinq.resetRecorder()
        ha.setProperty(DEVICE_ID, 'tanklight', 'rgb_command', 'not,a,colour')
        flushWrites(t)
        assert.equal(thinq.outbox.length, 0, 'an unparsable RGB is dropped')
    })

    test('an ON for a light that is already on is not sent', (t) => {
        const { ha, thinq } = readyDevice(t)

        /*
         * HA's MQTT light publishes the attribute AND an ON for every light command, so a
         * brightness change used to reach the appliance as two frames - and it beeps at each.
         */
        thinq.emit('data', buf(STATE_TANKLIGHT_ON_HEX))
        thinq.resetRecorder()

        ha.setProperty(DEVICE_ID, 'tanklight', 'command', 'ON')

        flushWrites(t)
        assert.equal(thinq.outbox.length, 0, 'nothing sent - the appliance is already on')

        ha.setProperty(DEVICE_ID, 'tanklight', 'brightness_command', '40')

        flushWrites(t)
        assert.equal(thinq.outbox.length, 1, 'the brightness itself still goes')
        assert.deepEqual(lastSentTLV(thinq), [{ t: 0x185, l: 1, v: 140 }])

        /* and turning it on when it really is off still sends */
        thinq.emit('data', buf(STATE_TANKLIGHT_OFF_HEX))
        thinq.resetRecorder()
        ha.setProperty(DEVICE_ID, 'tanklight', 'command', 'ON')
        flushWrites(t)
        assert.deepEqual(lastSentTLV(thinq), [{ t: 0x21e, l: 0, v: 1 }])
    })

    test('a burst of writes goes out as one frame', (t) => {
        const { ha, thinq } = readyDevice(t)
        thinq.emit('data', buf(STATE_TANKLIGHT_OFF_HEX))
        thinq.resetRecorder()

        /* what HA sends for one "turn the light on at 40 %" - two publishes, same instant */
        ha.setProperty(DEVICE_ID, 'tanklight', 'command', 'ON')
        ha.setProperty(DEVICE_ID, 'tanklight', 'brightness_command', '40')
        assert.equal(thinq.outbox.length, 0, 'nothing has gone out yet')

        flushWrites(t)
        assert.equal(thinq.outbox.length, 1, 'one frame, so the appliance chimes once')
        assert.deepEqual(lastSentTLV(thinq), [
            { t: 0x21e, l: 0, v: 1 },
            { t: 0x185, l: 1, v: 140 },
        ])

        /* a later write is simply the next frame */
        thinq.resetRecorder()
        ha.setProperty(DEVICE_ID, 'tanklight', 'effect_command', 'sky')
        flushWrites(t)
        assert.deepEqual(lastSentTLV(thinq), [{ t: 0x3e0, l: 0, v: 5 }])
    })

    test('a tag written twice in one window keeps the last value', (t) => {
        const { ha, thinq } = readyDevice(t)

        ha.setProperty(DEVICE_ID, 'fanspeed', 'command', 'low')
        ha.setProperty(DEVICE_ID, 'fanspeed', 'command', 'turbo')
        flushWrites(t)
        assert.equal(thinq.outbox.length, 1)
        assert.deepEqual(lastSentTLV(thinq), [{ t: 0x1fa, l: 0, v: 7 }])
    })

    test('a brightness at or below the offset publishes nothing', (t) => {
        const { ha, thinq } = readyDevice(t)

        thinq.emit('data', buf(STATE_TANKLIGHT_BRIGHT_40_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'tanklight', 'brightness_state'), 40)

        /* SYNTHETIC: raw 100 would be 0 %, which no capture contains and HA cannot use */
        thinq.emit('data', buf(synthState([{ t: 0x185, v: 100 }])))
        assert.equal(ha.getProperty(DEVICE_ID, 'tanklight', 'brightness_state'), 40, 'unchanged')
    })

    test('frames that are not TLV are ignored', (t) => {
        const { ha, thinq } = readyDevice(t)
        const before = { ...ha.devices[DEVICE_ID].properties }

        /* both parse as TLV without throwing, and both would publish nonsense if accepted */
        thinq.emit('data', buf(TELEMETRY_A8_HEX))
        thinq.emit('data', buf(PRIVATE_87FD_HEX))

        assert.deepEqual(ha.devices[DEVICE_ID].properties, before, 'no property changed')
    })

    test('a state frame marked 0x87 is still accepted', (t) => {
        const { ha, thinq } = readyDevice(t)

        /* same frame as STATE_FAN_LOW_HEX with the marker re-written to the usual 0x87: a
         * firmware behaving like every other model must keep working */
        const frame = buf(STATE_FAN_LOW_HEX)
        frame[6] = 0x87
        thinq.emit('data', frame)
        assert.equal(ha.getProperty(DEVICE_ID, 'fanspeed', 'state'), 'low')
    })
})
