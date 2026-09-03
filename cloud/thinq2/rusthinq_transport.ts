// An alternative source of `T2Device`-shaped objects, backed by rusthinq's raw wire-frame MQTT bus
// (raw_bus.rs) instead of `mqtt-broker.ts` + `DeviceAcceptor`. rusthinq owns the actual TLS/cloud
// tunnel to the appliance and the CLIP protocol underneath it; this only taps/injects the raw
// bytes it already decodes, over MQTT, so this process needs no certificates, no listening ports,
// and no knowledge of the tunnel at all - it can run anywhere that can reach the same broker,
// started and stopped independently of rusthinq itself.
//
// Everything downstream of a `Device` object - `DeviceManager`, `Bridge` (ha_bridge.ts),
// `Connection`, every `cloud/devices/*.ts` handler - is unchanged: they only ever call `id`/`meta`,
// `send_packet`, and listen for `data`/`sendData`/`close`, which is exactly what `RusthinqTransportDevice`
// below provides. `manager.accept()` still expects the real `Device` class's type, so the call site
// casts - see the comment there for exactly which members are (and are not) actually touched.

import { TypedEmitter } from 'tiny-typed-emitter'
import * as mqtt from 'mqtt'
import log from '@/util/logging'
import { type Metadata } from '../thinq'

type DeviceEvents = {
    data: (packet: Buffer) => void
    response: (body: Record<string, unknown>) => void
    sendData: (buf: Buffer) => void
    close: () => void
}

export type RusthinqTransportConfig = {
    mqtt_url: string
    mqtt_user?: string
    mqtt_pass?: string
    /* Must match rusthinq's `[mqtt] rusthinq_prefix` - where `<prefix>/devices` is published. */
    rusthinq_prefix: string
    /* Must match rusthinq's `[mqtt] raw_prefix` - where `raw/rx` / `raw/inject/set` live. Reading
     * rusthinq's own MILESTONES.md/raw_bus.rs: this is a trusted local-tooling surface, not meant
     * to be exposed beyond a firewalled broker - the same assumption this process makes. */
    raw_prefix: string
}

type DeviceSnapshotEntry = {
    model: string
    modelName?: string
    deviceType?: string
    swVersion?: string
    platform: 'thinq1' | 'thinq2'
}

type DeviceSnapshot = {
    devices: Record<string, DeviceSnapshotEntry>
}

/*
 * Stands in for thinq2/device.ts's `Device`. `send()` - the JSON CLIP-command path, as opposed to
 * `send_packet()`'s raw TLV bytes - publishes to raw_bus's `raw/inject-clip` leaf (as opposed to
 * `raw/inject`'s raw hex), which raw_bus.rs::register_inject decodes as JSON `{cmd, type, data}`
 * and dispatches as `SendToDevice::T2Clip`. The only caller of `send()` in this codebase is
 * `ACDevice.valuesReceived()`'s one-shot `setMaskingInfo` (clears the TLV notification blacklist so
 * the appliance pushes every change instead of only what's queried); without it the driver still
 * gets current values, just only as often as it polls for them.
 */
class RusthinqTransportDevice extends TypedEmitter<DeviceEvents> {
    readonly platform = 'thinq2' as const

    constructor(
        readonly id: string,
        readonly meta: Metadata,
        private readonly publishLeaf: (leaf: string, payload: string) => void,
    ) {
        super()
    }

    send(cmd: string, type: number, data: string | object) {
        // MqttSink::handle_message only dispatches to on_set_property (which is what
        // raw_bus.rs::register_inject listens on) when the topic's last segment is
        // literally "set" - the "raw/inject-clip" prop name comes from stripping that segment
        // off, not from the topic itself. Publishing without it is silently dropped:
        // register_inject never sees it, and there's no error path back to us.
        this.publishLeaf('raw/inject-clip/set', JSON.stringify({ cmd, type, data }))
    }

    send_packet(buf: Buffer) {
        this.emit('sendData', buf)
        this.publishLeaf('raw/inject/set', buf.toString('hex'))
    }
}

type SourceEvents = {
    newDevice: (dev: RusthinqTransportDevice) => void
}

/*
 * Connects to rusthinq's MQTT broker, learns which devices are currently connected from its
 * retained `<rusthinq_prefix>/devices` snapshot (devlist.rs - republished on every connect/
 * disconnect, so a (re)connect here always gets the current set immediately, no separate resync
 * needed), and emits a `RusthinqTransportDevice` for each newly-seen id, `close`ing the ones that
 * drop out. Thinq1 entries are skipped: raw_bus's inject path only exists for Thinq2 today.
 */
export class RusthinqTransportSource extends TypedEmitter<SourceEvents> {
    private readonly client: mqtt.MqttClient
    private readonly devices = new Map<string, RusthinqTransportDevice>()

    constructor(
        private readonly config: RusthinqTransportConfig,
        // Injectable so tests can hand this a fake client instead of opening a real socket - same
        // shape as ReservationJSONStore's injectable file ops.
        connect: (url: string, opts: mqtt.IClientOptions) => mqtt.MqttClient = mqtt.connect,
    ) {
        super()
        this.client = connect(config.mqtt_url, {
            username: config.mqtt_user,
            password: config.mqtt_pass,
        })
        this.client.on('connect', () => {
            log('status', 'rusthinq transport: connected, subscribing')
            this.client.subscribe(`${config.rusthinq_prefix}/devices`)
            this.client.subscribe(`${config.raw_prefix}/+/raw/rx`)
        })
        this.client.on('message', (topic, payload) => this.onMessage(topic, payload))
    }

    private onMessage(topic: string, payload: Buffer) {
        if (topic === `${this.config.rusthinq_prefix}/devices`) {
            this.onSnapshot(payload)
            return
        }

        const prefix = `${this.config.raw_prefix}/`
        const suffix = '/raw/rx'
        if (!topic.startsWith(prefix) || !topic.endsWith(suffix)) return

        const id = topic.slice(prefix.length, topic.length - suffix.length)
        const dev = this.devices.get(id)
        if (!dev) return // a frame for a device this source hasn't (yet) seen in the snapshot

        try {
            dev.emit('data', Buffer.from(payload.toString('utf-8'), 'hex'))
        } catch (err) {
            log('status', `rusthinq transport: bad hex on ${topic}: ${err}`)
        }
    }

    private onSnapshot(payload: Buffer) {
        let snapshot: DeviceSnapshot
        try {
            snapshot = JSON.parse(payload.toString('utf-8'))
        } catch (err) {
            log('status', `rusthinq transport: bad devices snapshot: ${err}`)
            return
        }

        const seen = new Set<string>()
        for (const [id, info] of Object.entries(snapshot.devices ?? {})) {
            if (info.platform !== 'thinq2') continue
            seen.add(id)
            if (this.devices.has(id)) continue

            const meta: Metadata = {
                modelId: info.model,
                modelName: info.modelName ?? info.model,
                swVersion: info.swVersion,
                deviceType: info.deviceType,
            }
            const dev = new RusthinqTransportDevice(id, meta, (leaf, hex) =>
                this.client.publish(`${this.config.raw_prefix}/${id}/${leaf}`, hex),
            )
            this.devices.set(id, dev)
            this.emit('newDevice', dev)
        }

        for (const [id, dev] of this.devices) {
            if (seen.has(id)) continue
            this.devices.delete(id)
            dev.emit('close')
        }
    }
}
