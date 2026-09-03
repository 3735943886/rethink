import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { RusthinqTransportSource } from '@/cloud/thinq2/rusthinq_transport'
import { setFilter } from '@/util/logging'

setFilter(() => false)

const CONFIG = {
    mqtt_url: 'mqtt://unused',
    rusthinq_prefix: 'rusthinq',
    raw_prefix: 'rusthinq-raw',
}

/* A minimal stand-in for mqtt.MqttClient: an EventEmitter plus the two calls this file makes. */
function fakeClient() {
    const published: { topic: string; payload: string }[] = []
    const subscriptions: string[] = []
    const client = new EventEmitter() as EventEmitter & { publish: (topic: string, payload: string) => void }
    client.publish = (topic, payload) => published.push({ topic, payload })
    ;(client as unknown as { subscribe: (topic: string) => void }).subscribe = (topic: string) =>
        subscriptions.push(topic)
    return { client, published, subscriptions }
}

function snapshot(devices: Record<string, { model: string; platform: 'thinq1' | 'thinq2' }>) {
    return JSON.stringify({ devices })
}

describe('RusthinqTransportSource', () => {
    test('subscribes to the device snapshot and the raw rx wildcard on connect', () => {
        const { client, subscriptions } = fakeClient()
        new RusthinqTransportSource(CONFIG, () => client as never)
        client.emit('connect')

        assert.deepEqual(subscriptions, ['rusthinq/devices', 'rusthinq-raw/+/raw/rx'])
    })

    test('emits newDevice for a thinq2 entry in the snapshot, skips thinq1', () => {
        const { client } = fakeClient()
        const source = new RusthinqTransportSource(CONFIG, () => client as never)
        const seen: string[] = []
        source.on('newDevice', (dev) => seen.push(dev.id))

        client.emit(
            'message',
            'rusthinq/devices',
            Buffer.from(
                snapshot({
                    dev1: { model: 'CST_570004_WW', platform: 'thinq2' },
                    dev2: { model: 'X', platform: 'thinq1' },
                }),
            ),
        )

        assert.deepEqual(seen, ['dev1'])
    })

    test('a device dropped from the snapshot gets its close event fired', () => {
        const { client } = fakeClient()
        const source = new RusthinqTransportSource(CONFIG, () => client as never)
        let dev: { id: string } | undefined
        let closed = false
        source.on('newDevice', (d) => {
            dev = d
            d.on('close', () => (closed = true))
        })

        client.emit(
            'message',
            'rusthinq/devices',
            Buffer.from(snapshot({ dev1: { model: 'CST_570004_WW', platform: 'thinq2' } })),
        )
        assert.ok(dev)
        assert.equal(closed, false)

        client.emit('message', 'rusthinq/devices', Buffer.from(snapshot({})))
        assert.equal(closed, true)
    })

    test('a raw/rx frame reaches the matching device as a data event', () => {
        const { client } = fakeClient()
        const source = new RusthinqTransportSource(CONFIG, () => client as never)
        const received: Buffer[] = []
        source.on('newDevice', (dev) => dev.on('data', (buf) => received.push(buf)))

        client.emit(
            'message',
            'rusthinq/devices',
            Buffer.from(snapshot({ dev1: { model: 'CST_570004_WW', platform: 'thinq2' } })),
        )
        client.emit('message', 'rusthinq-raw/dev1/raw/rx', Buffer.from('cafe01'))

        assert.deepEqual(received, [Buffer.from('cafe01', 'hex')])
    })

    test('send_packet publishes hex to raw/inject and still fires sendData locally', () => {
        const { client, published } = fakeClient()
        const source = new RusthinqTransportSource(CONFIG, () => client as never)
        let sawSendData: Buffer | undefined
        source.on('newDevice', (dev) => {
            dev.on('sendData', (buf) => (sawSendData = buf))
            dev.send_packet(Buffer.from([0x01, 0x02]))
        })

        client.emit(
            'message',
            'rusthinq/devices',
            Buffer.from(snapshot({ dev1: { model: 'CST_570004_WW', platform: 'thinq2' } })),
        )

        assert.deepEqual(sawSendData, Buffer.from([0x01, 0x02]))
        assert.deepEqual(published, [{ topic: 'rusthinq-raw/dev1/raw/inject/set', payload: '0102' }])
    })
})
