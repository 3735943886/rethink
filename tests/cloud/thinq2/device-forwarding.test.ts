import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { Broker, type PublishPacket } from '@/cloud/mqtt-broker'
import { Device } from '@/cloud/thinq2/device'
import type { ClipEnvelope } from '@/cloud/thinq2/clip'

const TOPIC = 'lime/devices/cassette'
const META = { modelId: 'CST_570004_WW', modelName: 'CST_570004_WW' }

function newDevice() {
    const broker = new Broker()
    const published: PublishPacket[] = []
    broker.on('publish', (packet) => published.push(packet))
    return { dev: new Device(broker, TOPIC, 'cassette', META), published }
}

const sent = (published: PublishPacket[]) => published.map((packet) => JSON.parse(packet.payload.toString()))

describe('forwarding a cloud message to the appliance', () => {
    // The whole point: an ack is matched to the message it answers by mid, so the one thing that must
    // not happen is this side inventing a new one.
    const ACK: ClipEnvelope = { did: 'cassette', mid: 1785283454163, cmd: 'ack', type: 1, data: 'AA08F000C5043EBB' }
    const PACKET: ClipEnvelope = { did: 'cassette', mid: 42, cmd: 'packet', type: 1, data: 'aa05f0dead55bb' }

    test('an acknowledgement arrives as the cloud wrote it', () => {
        const { dev, published } = newDevice()
        dev.forward_clip(ACK)

        assert.equal(published.length, 1)
        assert.equal(published[0].topic, TOPIC)
        assert.deepEqual(sent(published)[0], ACK)
    })

    test('a packet keeps the cloud mid too, since the appliance answers it', () => {
        const { dev, published } = newDevice()
        dev.forward_clip(PACKET)

        assert.deepEqual(sent(published)[0], PACKET)
    })

    test('a relayed packet is reported to the monitor on its way past', () => {
        const { dev, published } = newDevice()
        const seen: string[] = []
        dev.on('sendData', (buf) => seen.push(buf.toString('hex')))

        dev.forward_clip(PACKET)

        assert.deepEqual(sent(published)[0], PACKET)
        assert.deepEqual(seen, ['aa05f0dead55bb'])
    })

    test("rethink's own commands still go out under a mid of their own", () => {
        const { dev, published } = newDevice()
        dev.send_packet(Buffer.from('aa05f0dead55bb', 'hex'))

        const message = sent(published)[0]
        assert.equal(message.cmd, 'packet')
        assert.equal(message.data, 'aa05f0dead55bb')
        assert.equal(typeof message.mid, 'number')
    })
})
