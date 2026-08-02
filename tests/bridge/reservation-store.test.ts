import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ReservationJSONStore } from '@/bridge/reservation-store'

function temporaryDirectory(t: import('node:test').TestContext) {
    const path = mkdtempSync(join(tmpdir(), 'rethink-reservation-'))
    t.after(() => rmSync(path, { recursive: true }))
    return path
}

test('reservation store restores only finite future deadlines and tolerates missing or corrupt files', (t) => {
    const directory = temporaryDirectory(t)
    const warnings: string[] = []
    const store = new ReservationJSONStore(
        directory,
        () => 1000,
        undefined,
        (message) => warnings.push(message),
    )
    const path = join(directory, 'reservation_device-1.json')

    assert.deepEqual(store.load('device-1'), {})

    writeFileSync(path, '{not json')
    assert.deepEqual(store.load('device-1'), {})
    assert.match(warnings[0], /Ignoring corrupt reservation state/)

    writeFileSync(path, JSON.stringify({ start: 1000, stop: 2000, unrelated: 3000 }))
    assert.deepEqual(store.load('device-1'), { stop: 2000 })

    writeFileSync(path, JSON.stringify({ start: '3000', stop: null }))
    assert.deepEqual(store.load('device-1'), {})
})

test('reservation store surfaces unreadable state instead of silently dropping it', () => {
    const warnings: string[] = []
    const denied = Object.assign(new Error('permission denied'), { code: 'EACCES' })
    const store = new ReservationJSONStore(
        '/state',
        () => 0,
        {
            read: () => {
                throw denied
            },
            write: () => {},
            rename: () => {},
        },
        (message) => warnings.push(message),
    )

    assert.throws(() => store.load('device-1'), denied)
    assert.match(warnings[0], /Unable to read reservation state/)
})

test('reservation store validates device IDs before accessing the filesystem', () => {
    const paths: string[] = []
    const store = new ReservationJSONStore('/state', () => 0, {
        read: (path) => {
            paths.push(path)
            return '{}'
        },
        write: (path) => {
            paths.push(path)
        },
        rename: (_from, to) => {
            paths.push(to)
        },
    })

    assert.deepEqual(store.load('../escape'), {})
    store.save('../escape', { start: 1000 })
    assert.deepEqual(paths, [])

    assert.deepEqual(store.load('device.with:scope'), {})
    store.save('device.with:scope', { start: 1000 })
    assert.equal(paths[0], '/state/reservation_device.with:scope.json')
    assert.equal(paths[2], '/state/reservation_device.with:scope.json')
})

test('reservation store writes a complete temporary file before atomically renaming it', () => {
    const calls: Array<{ operation: string; from: string; to?: string }> = []
    const store = new ReservationJSONStore('/state', () => 0, {
        read: () => '{}',
        write: (path, data) => calls.push({ operation: 'write', from: path, to: data }),
        rename: (from, to) => calls.push({ operation: 'rename', from, to }),
    })

    store.save('device-1', { start: 2000, stop: undefined })

    assert.equal(calls.length, 2)
    assert.match(calls[0]!.from, /^\/state\/reservation_device-1\.json\.\d+\.0\.tmp$/)
    assert.equal(calls[0]!.to, '{"start":2000}')
    assert.deepEqual(calls[1], {
        operation: 'rename',
        from: calls[0]!.from,
        to: '/state/reservation_device-1.json',
    })
})
