import { describe, test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { AddressInfo } from 'node:net'
import { fromCode } from '@/bridge/oauth2'

// LG's token endpoint, answering whatever the test puts in `reply`.
let reply: unknown = {}
let server: Server
let authUrl: string

describe('OAuth2 sign-in', () => {
    before(async () => {
        server = createServer((req, res) => {
            res.setHeader('content-type', 'application/json')
            res.end(JSON.stringify(reply))
        })
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
        authUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    })

    after(async () => {
        await new Promise((resolve) => server.close(resolve))
    })

    test('a complete answer is accepted', async () => {
        reply = { access_token: 'access', refresh_token: 'refresh', expires_in: '3600' }
        const token = await fromCode(authUrl, 'code')
        assert.equal(token.accessToken, 'access')
        assert.equal(token.refreshToken, 'refresh')
        assert.ok(token.validUntil > Date.now())
    })

    test('an answer carrying only an expiry is refused', async () => {
        // It used to be accepted: the condition read (a && b && c) || typeof expires_in === 'number',
        // and the caller got a token whose fields were undefined.
        reply = { expires_in: 3600 }
        await assert.rejects(fromCode(authUrl, 'code'), /OAuth2 sign-in failed/)
    })

    test('an answer missing the refresh token is refused', async () => {
        reply = { access_token: 'access', expires_in: 3600 }
        await assert.rejects(fromCode(authUrl, 'code'), /OAuth2 sign-in failed/)
    })
})
