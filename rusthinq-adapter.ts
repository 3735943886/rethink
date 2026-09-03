// Alternative entrypoint to rethink-cloud.ts: runs the existing `cloud/devices/*.ts` handlers and
// Home Assistant integration (Connection/Bridge, unmodified) against a rusthinq daemon instead of
// rethink's own TLS/cloud tunnel + internal MQTT broker. See RusthinqTransportSource for how a
// `Device` is synthesized from rusthinq's raw wire-frame MQTT bus.
//
// Runs as its own OS process, independent of rusthinq-cloud - the two only ever touch each other
// through the shared MQTT broker, so this can be started, stopped, and redeployed on its own
// schedule. Point rusthinq's config.toml `[mqtt] raw_prefix` and this file's `rusthinq` config
// section at the same value and broker; nothing in rusthinq itself needs to change.
//
// Only Thinq2 device models are handled - see RusthinqTransportSource's note on why Thinq1 is
// out of scope for now.

import stripJsonComments from 'strip-json-comments'
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { Connection as HA_connection } from './cloud/homeassistant'
import HA_bridge from './cloud/ha_bridge'
import { DeviceManager } from './cloud/devmgr'
import { RusthinqTransportSource, type RusthinqTransportConfig } from './cloud/thinq2/rusthinq_transport'
import { type Device as T2Device } from './cloud/thinq2/device'
import { type HAConfig } from './util/config'
import log, { setFilter as setLogFilter } from './util/logging'
import { ReservationJSONStore } from './bridge/reservation-store'

type AdapterConfig = {
    homeassistant: HAConfig
    rusthinq: RusthinqTransportConfig
    bridge?: { storage_path: string }
    log?: string[]
}

const configPath = resolve(process.argv[2] ?? './rusthinq-adapter-config.json')
const configDir = dirname(configPath)
const config = JSON.parse(stripJsonComments(readFileSync(configPath).toString('utf-8'))) as AdapterConfig

if (config.homeassistant.storage_path) {
    config.homeassistant.storage_path = resolve(configDir, config.homeassistant.storage_path)
    mkdirSync(config.homeassistant.storage_path, { recursive: true })
}
if (config.bridge) {
    config.bridge.storage_path = resolve(configDir, config.bridge.storage_path)
    mkdirSync(config.bridge.storage_path, { recursive: true })
}

const enabled = Object.fromEntries((config.log ?? ['status']).map((key) => [key, true]))
setLogFilter((topic) => enabled[topic] || enabled['all'])

// Same "relay the LG app's on/off reservation ourselves" state ac_common.ts's relayReservation
// devices need - only in-memory if no storage_path is configured, same as rethink-cloud.ts.
const reservationStore = config.bridge ? new ReservationJSONStore(config.bridge.storage_path) : undefined

const ha = new HA_bridge(new HA_connection(config.homeassistant), reservationStore)
const manager = new DeviceManager()
manager.on('newDevice', (dev) => ha.newDevice(dev))

const source = new RusthinqTransportSource(config.rusthinq)
source.on('newDevice', (dev) => {
    // RusthinqTransportDevice only implements the subset of the real Device class that
    // DeviceManager/Bridge/HADevice/TLVDevice/ac_common.ts actually touch (id, meta, platform,
    // send_packet, the data/sendData/close events) - see rusthinq_transport.ts's header comment.
    manager.accept(dev as unknown as T2Device)
})

log('status', 'rusthinq TS adapter ready')
