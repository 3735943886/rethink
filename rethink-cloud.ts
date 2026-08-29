import express from 'express'
import stripJsonComments from 'strip-json-comments'
import { mkdirSync, readFileSync } from 'node:fs'
import * as https from 'node:https'
import { dirname, resolve } from 'node:path'
import { Broker } from './cloud/mqtt-broker'
import * as tls from 'node:tls'
import * as net from 'node:net'
import { routes as thinq1Routes } from './cloud/thinq1/http'
import { routes as thinq2Routes } from './cloud/thinq2/provisioning'
import { FirmwareHosts } from './cloud/thinq2/firmware'
import { sniRouter } from './cloud/thinq2/sni-passthrough'
import { DeviceAcceptor as T1Acceptor } from './cloud/thinq1/device'
import { DeviceAcceptor as T2Acceptor } from './cloud/thinq2/device'
import { Connection as HA_connection } from './cloud/homeassistant'
import HA_bridge from './cloud/ha_bridge'
import { normalize as normalizeConfig, RawConfig, CA } from './util/config'
import { createCa } from './util/pki'
import { CertificateIssuer } from './util/sni'
import * as Management from './management'

import log, { setFilter as setLogFilter } from './util/logging'
import { DeviceManager } from './cloud/devmgr'
import { Bridge } from './bridge'
import { JSONStorage } from './bridge/state'
import { ReservationJSONStore } from './bridge/reservation-store'

const configPath = resolve(process.argv[2] ?? './config.json')
const configDir = dirname(configPath)
const config = normalizeConfig(JSON.parse(stripJsonComments(readFileSync(configPath).toString('utf-8'))) as RawConfig)

config.ca_key_file = resolve(configDir, config.ca_key_file)
config.ca_cert_file = resolve(configDir, config.ca_cert_file)
if (config.homeassistant.storage_path) {
    config.homeassistant.storage_path = resolve(configDir, config.homeassistant.storage_path)
    mkdirSync(config.homeassistant.storage_path, { recursive: true })
}
if (config.bridge) config.bridge.storage_path = resolve(configDir, config.bridge.storage_path)

if (!config.log) config.log = ['status', 'incoming', 'HTTPS']

const enabled = Object.fromEntries(config.log.map((key) => [key, true]))
setLogFilter((topic) => {
    return enabled[topic] || enabled['all']
})

const caFiles = { certFile: config.ca_cert_file, keyFile: config.ca_key_file }

// The CA is the trust anchor an appliance pins when it fetches /route/certificate. It is no longer
// served as a server certificate - every name we answer to gets its own leaf below - so its subject
// does not have to match anything, and it is created once and then left alone. Only "there is no CA
// yet" leads to making one: overwriting a CA that appliances have already pinned would leave every
// one of them unable to connect until it is provisioned again, which is not a thing to do because a
// file could not be read.
function loadOrCreateCert(): CA {
    try {
        return {
            key: readFileSync(config.ca_key_file).toString('utf-8'),
            cert: readFileSync(config.ca_cert_file).toString('utf-8'),
        }
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }

    log('status', 'Creating a new key/certificate for the CA')
    createCa(config.hostname, caFiles)

    return {
        key: readFileSync(config.ca_key_file).toString('utf-8'),
        cert: readFileSync(config.ca_cert_file).toString('utf-8'),
    }
}

const ca = loadOrCreateCert()

// Appliances that reach us by redirection rather than by setup still ask for an LG hostname, which
// varies between units of the same model. Serve each requested name its own certificate, signed by
// the CA they already trust.
const issuer = new CertificateIssuer(caFiles, config.hostname)

// The default certificate - what a connection that sends no SNI at all gets, an appliance reaching
// us by address among them - is a leaf for config.hostname rather than the CA itself, so that it
// carries a subjectAltName. The CA has only a subject, which clients are free to stop honouring.
const tlsOptions = { ...issuer.issue(config.hostname), SNICallback: issuer.SNICallback }

// Thinq1
function t1setup(manager: DeviceManager) {
    // Thinq1 HTTPS server
    const app = express()
    app.use(function (req, res, next) {
        log('HTTPS', req.hostname, req.url)
        next()
    })

    app.use(thinq1Routes(config))

    // fallback
    app.use((req, res) => {
        res.json({})
    })

    https.createServer(tlsOptions, app).listen(config.thinq1_https_port.bind, config.thinq1_https_port.address)
    const acceptor = new T1Acceptor()
    tls.createServer(tlsOptions, acceptor.accept.bind(acceptor)).listen(
        config.thinq1_port.bind,
        config.thinq1_port.address,
    )
    acceptor.on('newDevice', manager.accept.bind(manager))
}

// Thinq2
function t2setup(manager: DeviceManager, firmwareHosts: FirmwareHosts) {
    // Thinq2 HTTPS server
    const app = express()
    app.use(express.json())

    app.use(function (req, res, next) {
        log('HTTPS', req.hostname, req.url)
        // Getting this far means a client completed a TLS handshake against a certificate issued
        // for this name and sent a real request - proof rethink answers it, which the passthrough
        // paths below must never override for this name again. See firmware.ts on #confirmedLocal.
        firmwareHosts.confirmLocal(req.hostname)
        next()
    })

    // `ca`, not `tlsOptions`: these routes hand out the CA itself and sign appliance certificates
    // with it. An appliance pins what it gets here, so it has to be the CA, never a per-name leaf.
    app.use(thinq2Routes(config, ca))

    // fallback
    app.use((req, res) => {
        // Nothing above answers this path, and the appliance is told so with an empty body - which
        // is indistinguishable, from its side, from the request having worked. Say what was asked
        // for, so a call rethink does not implement shows up instead of disappearing. The body is
        // deliberately not logged: this is whatever an unrecognised caller sent, and it ends up in
        // a file that gets copied around.
        log('HTTPS', 'unhandled', req.method, req.url, 'ua=' + (req.headers['user-agent'] ?? '-'))
        res.header('content-type', 'text/xml;charset=utf-8')
        res.end('')
    })

    // Not every connection arriving on 443 is one rethink should answer. A firmware or SOTA content
    // download is checked against the appliance's built-in roots, not the CA it pinned from us, so
    // impersonating the CDN cannot work - the appliance drops the handshake before it ever sends a
    // request. Decide from the ClientHello: names rethink serves are terminated here as before,
    // firmware hosts are spliced to the real server so the appliance validates against it directly.
    const httpsServer = https.createServer(tlsOptions, app)
    net.createServer(
        sniRouter(
            (name) => firmwareHosts.has(name),
            (socket) => httpsServer.emit('connection', socket),
        ),
    ).listen(config.https_port.bind, config.https_port.address)

    // firmwareHosts.noteUrlsIn (see the bridge) catches most of these before the appliance ever
    // connects, but it depends on spotting the right field in a cloud message, and there is no
    // fixed list of which cmd carries a download URL. As a catch-all that needs no such guess: a
    // name terminated here that the appliance immediately resets - exactly the firmware-download
    // symptom this file's passthrough comment describes - is proof the appliance wanted a real
    // root, not ours. Note it too, so its retry (appliances do retry) gets passed through instead.
    httpsServer.on('tlsClientError', (err, socket) => {
        // Not in @types/node, but set by the SNI callback that already ran before this fires.
        const name = (socket as unknown as { servername?: string }).servername
        if (!name) return
        log('HTTPS', 'passthrough', `${name} reset the local handshake (${err.message}); passing through next time`)
        firmwareHosts.note(`https://${name}/`)
    })

    // internal MQTT broker
    const broker = new Broker()

    if (config.mqtt) {
        tls.createServer(tlsOptions, broker.accept.bind(broker)).listen(
            config.mqtts_port.bind,
            config.mqtts_port.address,
        )
        net.createServer({}, broker.accept.bind(broker)).listen(config.mqtt_port.bind, config.mqtt_port.address)
    }

    const acceptor = new T2Acceptor(broker)
    acceptor.on('newDevice', manager.accept.bind(manager))
}

// Persistent driver state that outlives a restart. Right now that is the absolute deadlines of the
// on/off reservation the AC drivers relay; without a bridge storage path they simply run in memory.
if (config.bridge) mkdirSync(config.bridge.storage_path, { recursive: true })
const reservationStore = config.bridge ? new ReservationJSONStore(config.bridge.storage_path) : undefined

// HA connector
const ha = new HA_bridge(new HA_connection(config.homeassistant), reservationStore)
const manager = new DeviceManager()
manager.on('newDevice', (dev) => ha.newDevice(dev))

// Learned from the startFota messages the bridge carries, and consulted when deciding whether a
// connection on 443 is one rethink should answer at all.
const firmwareHosts = new FirmwareHosts()

t1setup(manager)
t2setup(manager, firmwareHosts)

let bridge: Bridge | undefined
if (config.bridge) {
    const storage = new JSONStorage(config.bridge.storage_path)
    bridge = new Bridge(storage, manager, firmwareHosts)
}

if (config.management_port)
    Management.app(ha, manager, bridge).listen(config.management_port.bind, config.management_port.address)

console.log('Rethink cloud ready')
