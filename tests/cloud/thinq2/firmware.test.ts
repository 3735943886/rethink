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

    test('noteUrlsIn finds a startFota-shaped url nested under any field name', () => {
        const hosts = new FirmwareHosts()
        hosts.noteUrlsIn({
            cmd: 'startFota',
            data: { updatingFwInfo: { downloadUrl: REAL_URL } },
        })

        assert.deepEqual(hosts.all(), ['objectcontent.lgthinq.com'])
    })

    test('noteUrlsIn finds urls under an unrelated cmd/field path, e.g. an osp SOTA install', () => {
        const hosts = new FirmwareHosts()
        hosts.noteUrlsIn({
            cmd: 'osp_command',
            data: { cmd: 'reqStartSota', appId: 'lupa.usr.clean_mode', contentUrl: REAL_URL },
        })

        assert.deepEqual(hosts.all(), ['objectcontent.lgthinq.com'])
    })

    test('noteUrlsIn collects every url at any depth, including in arrays', () => {
        const hosts = new FirmwareHosts()
        hosts.noteUrlsIn({
            a: [{ b: 'https://one.example.invalid/x' }, 'https://two.example.invalid/y'],
            c: { d: { e: 'https://three.example.invalid/z' } },
        })

        assert.deepEqual(
            hosts.all().sort(),
            ['one.example.invalid', 'three.example.invalid', 'two.example.invalid'].sort(),
        )
    })

    test('noteUrlsIn ignores non-url fields and does not throw on cycles', () => {
        const hosts = new FirmwareHosts()
        const cyclic: Record<string, unknown> = { name: 'not a url', n: 42 }
        cyclic.self = cyclic
        hosts.noteUrlsIn(cyclic)

        assert.deepEqual(hosts.all(), [])
    })

    test('confirmLocal makes a host immune to note(), even for a URL naming it directly', () => {
        const hosts = new FirmwareHosts()
        hosts.confirmLocal('kic-common.lgthinq.com')
        hosts.note('https://kic-common.lgthinq.com/some/path')

        assert.ok(!hosts.has('kic-common.lgthinq.com'))
        assert.deepEqual(hosts.all(), [])
    })

    test('confirmLocal makes a host immune to noteUrlsIn too', () => {
        const hosts = new FirmwareHosts()
        hosts.confirmLocal('kic-common.lgthinq.com')
        hosts.noteUrlsIn({ cmd: 'whatever', data: { url: 'https://kic-common.lgthinq.com/x' } })

        assert.ok(!hosts.has('kic-common.lgthinq.com'))
    })

    test('confirmLocal evicts a host note() already (mis)added, the incident this exists for', () => {
        const hosts = new FirmwareHosts()
        // A caller that was never going to trust rethink's CA rejects the handshake, and the
        // reactive tlsClientError path misreads that as a firmware host - exactly what happened to
        // kic-common.lgthinq.com in production. A later real request from a client that does trust
        // it (proof the host is actually served locally) must undo that, not just prevent new ones.
        hosts.note('https://kic-common.lgthinq.com/')
        assert.ok(hosts.has('kic-common.lgthinq.com'))

        hosts.confirmLocal('kic-common.lgthinq.com')
        assert.ok(!hosts.has('kic-common.lgthinq.com'))
    })

    test('confirmLocal does not affect other hosts', () => {
        const hosts = new FirmwareHosts()
        hosts.note(REAL_URL)
        hosts.confirmLocal('kic-common.lgthinq.com')

        assert.ok(hosts.has('objectcontent.lgthinq.com'))
    })

    test('two registries do not share state', () => {
        const a = new FirmwareHosts()
        const b = new FirmwareHosts()
        a.note(REAL_URL)

        assert.ok(a.has('objectcontent.lgthinq.com'))
        assert.ok(!b.has('objectcontent.lgthinq.com'))
    })
})
