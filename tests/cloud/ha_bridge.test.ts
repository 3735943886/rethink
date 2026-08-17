import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import Bridge from '@/cloud/ha_bridge'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device } from '@/tests/helpers/mocks'

const META: Metadata = { modelId: 'Y_V8_F___W.B_2QEUK', modelName: 'Y_V8_F___W.B_2QEUK', swVersion: '1.0' }

class AvailabilityRecordingHA extends MockHAConnection {
    availabilityHistory: string[] = []

    override publishProperty(id: string, property: string, value: string | number) {
        super.publishProperty(id, property, value)
        if (property === 'availability') this.availabilityHistory.push(String(value))
    }
}

describe('HA bridge device replacement', () => {
    test('does not publish offline while atomically replacing a live connection', async () => {
        const ha = new AvailabilityRecordingHA()
        const bridge = new Bridge(ha.asConnection(), undefined, 20)
        const oldConnection = new MockThinq2Device('ac-id', META)
        const newConnection = new MockThinq2Device('ac-id', META)

        bridge.newDevice(oldConnection)
        ha.availabilityHistory = []

        bridge.newDevice(newConnection)
        assert.deepEqual(ha.availabilityHistory, ['online'])

        // Closing the superseded connection must not affect the replacement.
        oldConnection.emit('close')
        assert.deepEqual(ha.availabilityHistory, ['online'])

        // A genuine close of the active connection still publishes offline.
        newConnection.emit('close')
        await new Promise((resolve) => setTimeout(resolve, 30))
        assert.deepEqual(ha.availabilityHistory, ['online', 'offline'])
    })

    test('suppresses a brief offline blip when disconnect precedes re-registration', async () => {
        const ha = new AvailabilityRecordingHA()
        const bridge = new Bridge(ha.asConnection(), undefined, 20)
        const oldConnection = new MockThinq2Device('ac-id', META)
        const newConnection = new MockThinq2Device('ac-id', META)

        bridge.newDevice(oldConnection)
        ha.availabilityHistory = []

        oldConnection.emit('close')
        await new Promise((resolve) => setTimeout(resolve, 5))
        bridge.newDevice(newConnection)
        await new Promise((resolve) => setTimeout(resolve, 30))

        assert.deepEqual(ha.availabilityHistory, ['online'])
    })
})
