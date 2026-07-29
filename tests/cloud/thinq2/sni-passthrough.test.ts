import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import * as tls from 'node:tls'
import * as net from 'node:net'
import '@/tests/helpers/mocks'
import { parseSniFromClientHello, sniRouter } from '@/cloud/thinq2/sni-passthrough'

/** A genuine ClientHello, produced by node's own TLS client rather than hand-assembled. */
function clientHelloFor(servername: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const server = net.createServer((socket) => {
            socket.once('readable', () => {
                const head = socket.read() as Buffer | null
                socket.destroy()
                server.close()
                if (head) resolve(head)
                else reject(new Error('no ClientHello'))
            })
        })

        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address() as net.AddressInfo
            const socket = tls.connect({ port, host: '127.0.0.1', servername, rejectUnauthorized: false })
            socket.on('error', () => {}) // the server hangs up on purpose
        })
    })
}

describe('parseSniFromClientHello', () => {
    test('reads the name out of a real ClientHello', async () => {
        const hello = await clientHelloFor('objectcontent.lgthinq.com')

        assert.equal(parseSniFromClientHello(hello), 'objectcontent.lgthinq.com')
    })

    test('reads a name of a different length, so no offset is hardcoded', async () => {
        const hello = await clientHelloFor('kic-common.lgthinq.com')

        assert.equal(parseSniFromClientHello(hello), 'kic-common.lgthinq.com')
    })

    test('a connection with no SNI is not claimed for passthrough', async () => {
        // No servername: node omits the extension entirely.
        const hello = await clientHelloFor('')

        assert.equal(parseSniFromClientHello(hello), undefined)
    })

    test('rubbish is no name rather than a throw, so it gets terminated as before', () => {
        for (const bad of [
            Buffer.alloc(0),
            Buffer.from([0x16]),
            Buffer.from('GET / HTTP/1.1\r\n\r\n'),
            Buffer.alloc(200), // right length, wrong content
        ]) {
            assert.equal(parseSniFromClientHello(bad), undefined)
        }
    })

    test('a truncated ClientHello does not read past the end', async () => {
        const hello = await clientHelloFor('objectcontent.lgthinq.com')

        for (let n = 1; n < hello.length; n++) {
            const cut = hello.subarray(0, n)
            const name = parseSniFromClientHello(cut)
            // Either it has not seen the extension yet, or it has seen all of it.
            assert.ok(name === undefined || name === 'objectcontent.lgthinq.com')
        }
    })
})

describe('sniRouter', () => {
    test('terminates a name it serves, and passes the socket on untouched', async () => {
        const seen: string[] = []
        const terminated: Buffer[] = []

        const server = net.createServer(
            sniRouter(
                (name) => {
                    seen.push(name)
                    return false
                },
                (socket) => {
                    socket.once('readable', () => {
                        const head = socket.read() as Buffer | null
                        if (head) terminated.push(head)
                        socket.destroy()
                    })
                },
            ),
        )

        await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
        const { port } = server.address() as net.AddressInfo

        const hello = await clientHelloFor('kic-common.lgthinq.com')
        const client = net.connect({ port, host: '127.0.0.1' })
        await new Promise<void>((r) => client.on('connect', () => r()))
        client.write(hello)

        await new Promise((r) => setTimeout(r, 150))
        client.destroy()
        server.close()

        assert.deepEqual(seen, ['kic-common.lgthinq.com'])
        // The ClientHello reaches the TLS server intact - unshift put it back.
        assert.equal(terminated.length, 1)
        assert.deepEqual(terminated[0], hello)
    })
})
