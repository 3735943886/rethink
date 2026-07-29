// Hand a connection back to the real server instead of impersonating it.
//
// An appliance behind port redirection sends rethink every connection it makes on 443, including
// ones rethink has no business answering. Firmware downloads are the case that forced this: the
// image lives on a public CDN, and the appliance checks that certificate against a built-in root
// bundle rather than the CA it pinned from /route/certificate. rethink cannot produce a
// certificate that bundle accepts - no amount of proxying at the HTTP layer helps, because the
// appliance drops the connection during the handshake, before there is a request to serve. That is
// exactly what it did: conntrack showed the connection reaching rethink and reaching ESTABLISHED,
// rethink logged ECONNRESET from the TLS side, and no request was ever logged.
//
// So don't terminate it. The ClientHello names the host it wants, and that is enough to decide
// before any TLS state exists: for a name rethink serves, hand the socket to the TLS server as
// before; for a name it does not, open a connection to the real host and splice the two together.
// The appliance then completes its handshake with the CDN itself and validates against whatever
// root it likes, while everything else about the redirection stays as it was.
//
// Only names that have been learned from a startFota are passed through, so this is not a general
// way to make rethink open connections to wherever a client asks for.

import * as net from 'node:net'
import log from '@/util/logging'

/**
 * The server name in a TLS ClientHello, or undefined if this is not one, it is incomplete, or it
 * carries no SNI extension. Deliberately total: anything unparseable is simply "no name", which
 * routes the connection to the TLS server exactly as before this existed.
 */
export function parseSniFromClientHello(buf: Buffer): string | undefined {
    let p = 0
    const need = (n: number) => p + n <= buf.length

    // TLS record: type(1) version(2) length(2), then handshake: type(1) length(3) version(2)
    if (!need(43) || buf[0] !== 0x16 || buf[5] !== 0x01) return undefined
    p = 43 // skip to the session id, past record+handshake headers, client version and random

    if (!need(1)) return undefined
    p += 1 + buf[p] // session id

    if (!need(2)) return undefined
    p += 2 + buf.readUInt16BE(p) // cipher suites

    if (!need(1)) return undefined
    p += 1 + buf[p] // compression methods

    if (!need(2)) return undefined
    const extensionsEnd = p + 2 + buf.readUInt16BE(p)
    p += 2

    while (p + 4 <= Math.min(extensionsEnd, buf.length)) {
        const type = buf.readUInt16BE(p)
        const length = buf.readUInt16BE(p + 2)
        const body = p + 4
        if (body + length > buf.length) return undefined

        if (type === 0x0000) {
            // server_name: list length(2), then name type(1) name length(2) name
            if (length < 5 || buf[body + 2] !== 0x00) return undefined
            const nameLength = buf.readUInt16BE(body + 3)
            if (body + 5 + nameLength > buf.length) return undefined
            return buf.subarray(body + 5, body + 5 + nameLength).toString('latin1')
        }

        p = body + length
    }

    return undefined
}

/**
 * A `net` connection handler that splices connections for `shouldPassThrough` names to the real
 * host, and gives everything else to `terminate` - the TLS server, which sees an untouched socket.
 */
export function sniRouter(shouldPassThrough: (name: string) => boolean, terminate: (socket: net.Socket) => void) {
    return function (socket: net.Socket) {
        socket.once('error', () => socket.destroy())

        socket.once('readable', () => {
            // A ClientHello arrives in one segment in practice. If it did not, the parse fails and
            // the connection is terminated locally, which is what used to happen to all of them.
            const head = socket.read() as Buffer | null
            if (!head) {
                terminate(socket)
                return
            }

            socket.unshift(head)

            const name = parseSniFromClientHello(head)
            if (!name || !shouldPassThrough(name)) {
                terminate(socket)
                return
            }

            log('HTTPS', 'passthrough', `${name} -> real server`)

            const upstream = net.connect({ host: name, port: 443 }, () => {
                socket.pipe(upstream)
                upstream.pipe(socket)
            })

            const close = (err?: Error) => {
                if (err) log('HTTPS', 'passthrough', `${name}: ${err}`)
                socket.destroy()
                upstream.destroy()
            }

            upstream.once('error', close)
            socket.once('error', close)
            upstream.once('close', () => socket.destroy())
            socket.once('close', () => upstream.destroy())
        })
    }
}
