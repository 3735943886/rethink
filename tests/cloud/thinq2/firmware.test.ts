import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import '@/tests/helpers/mocks'
import { FirmwareHosts } from '@/cloud/thinq2/firmware'

// The address out of a real startFota, and the shape of what surrounds it.
const REAL_URL =
    'https://objectcontent.lgthinq.com/a5c374ac-af52-4c97-a960-219b7cab29c3?hdnts=exp=1785286168~hmac=eb123b5d'

describe('FirmwareHosts', () => {
    test('nothing is a firmware host until a startFota says so', () => {
        const hosts = new FirmwareHosts()

        // No CDN is named in the source, so this is the state rethink starts in - which means an
        // update that works is evidence startFota was read, rather than guessed at correctly.
        assert.deepEqual(hosts.all(), [])
        assert.ok(!hosts.has('objectcontent.lgthinq.com'))
    })

    test('learns a host from a firmware url', () => {
        const hosts = new FirmwareHosts()
        hosts.note('https://fw.example.invalid/image.bin?sig=abc')

        assert.ok(hosts.has('fw.example.invalid'))
    })

    test('keeps the signature-bearing query out of the host', () => {
        const hosts = new FirmwareHosts()
        hosts.note(REAL_URL)

        assert.deepEqual(hosts.all(), ['objectcontent.lgthinq.com'])
    })

    test('a name it was never told about is not served', () => {
        const hosts = new FirmwareHosts()
        hosts.note(REAL_URL)

        // The names rethink is here to impersonate must keep being terminated locally.
        assert.ok(!hosts.has('kic-common.lgthinq.com'))
        assert.ok(!hosts.has('common.iot.kic.lgthinq.com'))
    })

    test('ignores anything that is not a url', () => {
        const hosts = new FirmwareHosts()
        for (const bad of [undefined, null, 42, {}, '', 'not a url', '/relative/path.bin']) {
            hosts.note(bad)
        }

        assert.deepEqual(hosts.all(), [])
    })

    test('ignores schemes that are not http(s), so a url cannot name a local file', () => {
        const hosts = new FirmwareHosts()
        hosts.note('file:///etc/passwd')
        hosts.note('ftp://fw.example.invalid/image.bin')

        assert.deepEqual(hosts.all(), [])
    })

    test('does not record the same host twice', () => {
        const hosts = new FirmwareHosts()
        hosts.note('https://dup.example.invalid/a.bin')
        hosts.note('https://dup.example.invalid/b.bin')

        assert.deepEqual(hosts.all(), ['dup.example.invalid'])
    })

    test('two registries do not share state', () => {
        const a = new FirmwareHosts()
        const b = new FirmwareHosts()
        a.note(REAL_URL)

        assert.ok(a.has('objectcontent.lgthinq.com'))
        assert.ok(!b.has('objectcontent.lgthinq.com'))
    })
})
