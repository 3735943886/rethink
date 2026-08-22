import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Connection } from '@/cloud/homeassistant'
import { KeyedDebounce } from '@/util/debounce'
import { enableMockTimers, tickMockTimers } from '@/tests/helpers/timers'
import { setFilter } from '@/util/logging'

setFilter(() => false)

const ID = 'test-id'
const GRACE_MS = 5000

type Published = { topic: string; payload: string }

/**
 * A Connection without the MQTT socket its constructor would open. Publishing touches only these
 * four members, so this exercises the real publishProperty with nothing else in the way.
 */
function makeConnection() {
    const published: Published[] = []
    const con = Object.create(Connection.prototype) as Connection

    Object.assign(con, {
        config: { rethink_prefix: 'rethink' },
        client: { publish: (topic: string, payload: string) => published.push({ topic, payload }) },
        publishedAvailability: new Set<string>(),
        deferredOffline: new KeyedDebounce(),
    })

    return { con, published }
}

describe('availability publishing', () => {
    test('an appliance that comes straight back is never published as offline', (t) => {
        enableMockTimers(t)
        const { con, published } = makeConnection()

        // what a session replacement looks like: the old device dropped, the new one up 20ms later
        con.publishProperty(ID, 'availability', 'offline')
        tickMockTimers(t, 20)
        con.publishProperty(ID, 'availability', 'online')

        tickMockTimers(t, GRACE_MS * 2)
        assert.deepEqual(published, [{ topic: 'rethink/test-id/availability', payload: 'online' }])
    })

    test('an appliance that stays away is published as offline, once the grace period is up', (t) => {
        enableMockTimers(t)
        const { con, published } = makeConnection()

        con.publishProperty(ID, 'availability', 'offline')
        tickMockTimers(t, GRACE_MS - 100)
        assert.deepEqual(published, [], 'nothing published while the appliance might still return')

        tickMockTimers(t, 200)
        assert.deepEqual(published, [{ topic: 'rethink/test-id/availability', payload: 'offline' }])
        assert.ok(con.publishedAvailability.has(ID), 'the deferred publish still records the topic')
    })

    test('one appliance flapping does not hold back another going offline', (t) => {
        enableMockTimers(t)
        const { con, published } = makeConnection()

        con.publishProperty('flapping', 'availability', 'offline')
        con.publishProperty('gone', 'availability', 'offline')
        con.publishProperty('flapping', 'availability', 'online')

        tickMockTimers(t, GRACE_MS * 2)
        assert.deepEqual(published, [
            { topic: 'rethink/flapping/availability', payload: 'online' },
            { topic: 'rethink/gone/availability', payload: 'offline' },
        ])
    })

    test('everything other than availability is published as it comes', (t) => {
        enableMockTimers(t)
        const { con, published } = makeConnection()

        con.publishProperty(ID, 'power', 'ON')
        con.publishProperty(ID, 'temperature', 24)

        assert.deepEqual(published, [
            { topic: 'rethink/test-id/power', payload: 'ON' },
            { topic: 'rethink/test-id/temperature', payload: '24' },
        ])
        assert.ok(!con.publishedAvailability.has(ID), 'and none of it counts as an availability publish')
    })
})

describe('KeyedDebounce', () => {
    test('the action runs once the delay is up', (t) => {
        enableMockTimers(t)
        const debounce = new KeyedDebounce()
        const ran: string[] = []

        debounce.defer('a', 1000, () => ran.push('a'))
        assert.ok(debounce.isPending('a'))

        tickMockTimers(t, 1000)
        assert.deepEqual(ran, ['a'])
        assert.ok(!debounce.isPending('a'), 'and stops being pending once it has run')
    })

    test('deferring the same key again replaces what was waiting', (t) => {
        enableMockTimers(t)
        const debounce = new KeyedDebounce()
        const ran: string[] = []

        debounce.defer('a', 1000, () => ran.push('first'))
        tickMockTimers(t, 900)
        debounce.defer('a', 1000, () => ran.push('second'))

        tickMockTimers(t, 1000)
        assert.deepEqual(ran, ['second'])
    })

    test('cancelling drops the action', (t) => {
        enableMockTimers(t)
        const debounce = new KeyedDebounce()
        const ran: string[] = []

        debounce.defer('a', 1000, () => ran.push('a'))
        debounce.cancel('a')
        assert.ok(!debounce.isPending('a'))

        tickMockTimers(t, 5000)
        assert.deepEqual(ran, [])
    })

    test('cancelling a key with nothing pending is harmless', () => {
        const debounce = new KeyedDebounce()
        debounce.cancel('never-deferred')
        assert.ok(!debounce.isPending('never-deferred'))
    })
})

describe('persistent device state', () => {
    function makeConnectionWithStorage(storage_path?: string) {
        const con = Object.create(Connection.prototype) as Connection
        Object.assign(con, { config: { rethink_prefix: 'rethink', storage_path } })
        return con
    }

    test('a device with no prior state reads back empty', () => {
        const dir = mkdtempSync(join(tmpdir(), 'rethink-ha-state-'))
        try {
            const con = makeConnectionWithStorage(dir)
            assert.deepEqual(con.getPersistentDeviceState(ID), {})
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })

    test('a written state round-trips through get', () => {
        const dir = mkdtempSync(join(tmpdir(), 'rethink-ha-state-'))
        try {
            const con = makeConnectionWithStorage(dir)
            con.setPersistentDeviceState(ID, { totalEnergy: 42 })
            assert.deepEqual(con.getPersistentDeviceState(ID), { totalEnergy: 42 })
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })

    test('two devices do not collide on the same file', () => {
        const dir = mkdtempSync(join(tmpdir(), 'rethink-ha-state-'))
        try {
            const con = makeConnectionWithStorage(dir)
            con.setPersistentDeviceState('device-a', { totalEnergy: 1 })
            con.setPersistentDeviceState('device-b', { totalEnergy: 2 })
            assert.deepEqual(con.getPersistentDeviceState('device-a'), { totalEnergy: 1 })
            assert.deepEqual(con.getPersistentDeviceState('device-b'), { totalEnergy: 2 })
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })

    test('a corrupt state file is treated as empty rather than thrown', () => {
        const dir = mkdtempSync(join(tmpdir(), 'rethink-ha-state-'))
        try {
            const con = makeConnectionWithStorage(dir)
            con.setPersistentDeviceState(ID, { totalEnergy: 1 })
            const [file] = readdirSync(dir)
            writeFileSync(join(dir, file), 'not json', 'utf-8')
            assert.deepEqual(con.getPersistentDeviceState(ID), {})
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })

    test('without a configured storage_path, state is not persisted', () => {
        const con = makeConnectionWithStorage(undefined)
        con.setPersistentDeviceState(ID, { totalEnergy: 1 })
        assert.deepEqual(con.getPersistentDeviceState(ID), {})
    })
})
