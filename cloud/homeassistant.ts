import * as mqtt from 'mqtt'
import { TypedEmitter } from 'tiny-typed-emitter'
import { HAConfig } from '@/util/config'
import { KeyedDebounce } from '@/util/debounce'
import log from '@/util/logging'
import { createHash } from 'node:crypto'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Notes on availability topic handling:
// 1. We want HA to be able to tell if a device is available.
// 2. When rethink stops, all devices should turn "offline"
// 3. But we can register only a single LWT topic at the MQTT broker
// 4. We define two availability topics. One per-device, the other - global
// 5. In a previous attempt, we had used availablility_mode: latest, and published all availability
// 	  messages with retain=off. This had one flaw: if HA was not already subscribed to the per-device
//    topic, it would miss the message and display the device as "offline" until it reconnected.
// 6. If we publish the per-device availability message with retain=true, then HA will received it
//    once it subscribes. It will also mean that these messages can survive from one `rethink` run
//	  to another. This would cause these "phatom" devices to appear "online" as soon as the new
//	  `rethink` instance starts.
// 7. To solve this, we subscribe to the availability topics and clean up all the retained "online"
// 	  messages on startup.
// 8. An appliance that abandons its session and immediately re-establishes it is not a device that
//    went away, so it must not be published as one - see AVAILABILITY_GRACE_MS.

/*
 * LG's Wi-Fi modules routinely drop their cloud session and re-run the whole provisioning
 * handshake. rethink sees the old session end and a new one begin - 9 to 234 milliseconds apart in
 * a day of captures - and rebuilds the Home Assistant device in between, which flaps the
 * availability topic and leaves an "unavailable" mark in the history of an appliance that was never
 * actually away. The quietest appliances suffer most: one that reports its status once an hour
 * gives the access point no traffic to see, so it is the first to be aged out and reconnect.
 *
 * So "offline" waits a moment before it goes out, and an "online" for the same device within that
 * window cancels it - nothing is published, because nothing happened. The cost is that a device
 * that really is gone is reported this much later, which no consumer of the topic cares about.
 */
const AVAILABILITY_GRACE_MS = 5000

function recursiveReplace(obj: unknown, replacements: Record<string, string>): unknown {
    if (Array.isArray(obj)) {
        return obj.map((v) => recursiveReplace(v, replacements))
    } else if (obj === null) {
        return null
    } else if (typeof obj === 'object') {
        return Object.fromEntries(
            Object.entries(obj as object).map(([key, value]) => [key, recursiveReplace(value, replacements)]),
        )
    } else if (typeof obj === 'string') {
        let str: string = obj
        for (let pattern in replacements) {
            str = str.replaceAll(pattern, replacements[pattern])
        }
        return str
    } else return obj
}

type ConnectionEvents = {
    discovery: () => void
    setProperty: (id: string, key: string, value: string) => void
    statusChanged: (status: boolean) => void
}

export class Connection extends TypedEmitter<ConnectionEvents> {
    client: mqtt.MqttClient
    isConnected: boolean = false

    // record for which devices we have published the availability topic during this connection
    readonly publishedAvailability = new Set<string>()

    // "offline" publishes held back for the grace period, keyed by device id
    readonly deferredOffline = new KeyedDebounce()

    constructor(readonly config: HAConfig) {
        super()

        // mqtt module has builtin reconnection support
        this.client = mqtt.connect(this.config.mqtt_url, {
            will: {
                topic: config.rethink_prefix + '/availability',
                payload: Buffer.from('offline'),
                retain: true,
            },
            username: this.config.mqtt_user,
            password: this.config.mqtt_pass,
        })
        this.client.on('connect', this.connected.bind(this))
        this.client.on('close', this.disconnected.bind(this))
        this.client.on('message', this.received.bind(this))
    }

    /* Persist derived HA device state outside the container filesystem, so a total a device driver
     * computes itself (e.g. accumulated energy) survives a restart instead of resetting to zero. */
    private persistentDeviceStatePath(id: string) {
        if (!this.config.storage_path) return undefined
        const safeId = createHash('sha256').update(id).digest('hex')
        return join(this.config.storage_path, `device_${safeId}.json`)
    }

    getPersistentDeviceState(id: string): Record<string, unknown> {
        const path = this.persistentDeviceStatePath(id)
        if (!path) return {}

        try {
            return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>
        } catch (err) {
            return {}
        }
    }

    setPersistentDeviceState(id: string, state: Record<string, unknown>) {
        const path = this.persistentDeviceStatePath(id)
        if (!path) return

        const tmpPath = `${path}.tmp`
        try {
            writeFileSync(tmpPath, JSON.stringify(state), { encoding: 'utf-8', mode: 0o600 })
            renameSync(tmpPath, path)
        } catch (err) {
            console.warn(`Unable to persist Home Assistant device state for ${id}: ${err}`)
        }
    }

    connected() {
        this.publishedAvailability.clear()
        log('status', 'HA mqtt connection established')
        this.isConnected = true

        // homeassistant/status
        this.client.subscribe(this.config.discovery_prefix + '/status')
        // rethink/ID/PROPERTY/set, most devices use single-segment property names.
        this.client.subscribe(this.config.rethink_prefix + '/+/+/set')
        // Two-in-one devices (e.g. washer+dryer) namespace by unit: rethink/ID/UNIT/PROPERTY/set
        this.client.subscribe(this.config.rethink_prefix + '/+/+/+/set')

        this.client.subscribe(this.config.rethink_prefix + '/+/availability')
        this.client.publish(this.config.rethink_prefix + '/availability', Buffer.from('online'), { retain: true })

        this.emit('discovery')
        this.emit('statusChanged', true)
    }

    disconnected() {
        this.isConnected = false
        log('status', 'HA mqtt connection lost')
        this.emit('statusChanged', false)
    }

    received(topic: string, message: Buffer, packet: mqtt.IPublishPacket) {
        try {
            if (topic === this.config.discovery_prefix + '/status' && message.toString('utf-8') === 'online') {
                log('status', 'HA online, starting discovery process')
                this.emit('discovery')
            }

            if (topic.startsWith(this.config.rethink_prefix + '/')) {
                const pathelements = topic.substring(this.config.rethink_prefix.length + 1).split('/')
                // rethink/ID/PROPERTY/set (single-segment) or rethink/ID/UNIT/PROPERTY/set (two-in-one devices)
                // prop is everything between the ID and the trailing /set, joined back with /
                if (pathelements.length >= 3 && pathelements[pathelements.length - 1] === 'set') {
                    const id = pathelements[0]
                    const prop = pathelements.slice(1, -1).join('/')
                    this.emit('setProperty', id, prop, message.toString('utf-8'))
                }

                // rethink/+/availability
                // only for retained deliveries. Packets delivered in real-time will not be caught by this
                if (
                    pathelements.length === 2 &&
                    pathelements[1] === 'availability' &&
                    message.toString('utf-8') === 'online' &&
                    packet.retain
                ) {
                    // clear any retained availability topic, but only if we hadn't published a message on that topic yet
                    if (!this.publishedAvailability.has(pathelements[0]))
                        this.client.publish(topic, 'offline', { retain: true })
                }
            }
        } catch (err) {
            console.warn(`Error processing MQTT packet: ${err}`)
        }
    }

    publishConfig(id: string, config: DeviceDiscovery) {
        const discoveryTopic = `${this.config.discovery_prefix}/device/rethink/${id}`
        const deviceTopic = `${this.config.rethink_prefix}/${id}`
        const replacements = {
            $this: deviceTopic,
            $rethink: this.config.rethink_prefix,
            $deviceid: id,
        }
        const configPayload = JSON.stringify(recursiveReplace(config, replacements))
        log('publish', configPayload)
        this.client.publish(discoveryTopic + '/config', configPayload)
    }

    publishProperty(id: string, property: string, value: string | number, options?: mqtt.IClientPublishOptions) {
        const opts = options ?? { retain: true } // FIXME?
        const payload = typeof value === 'number' ? value.toString() : value

        if (property === 'availability') {
            // whichever way availability just moved, it supersedes anything held back for this device
            this.deferredOffline.cancel(id)

            if (payload === 'offline') {
                this.deferredOffline.defer(id, AVAILABILITY_GRACE_MS, () =>
                    this.publishNow(id, property, payload, opts),
                )
                return
            }
        }

        this.publishNow(id, property, payload, opts)
    }

    private publishNow(id: string, property: string, payload: string, options: mqtt.IClientPublishOptions) {
        const deviceTopic = `${this.config.rethink_prefix}/${id}`
        if (property === 'availability') this.publishedAvailability.add(id)

        log('publish', id, property, payload)
        this.client.publish(deviceTopic + '/' + property, payload, options)
    }
}

export type DeviceInfo = {
    identifiers: string | string[]
    manufacturer?: string
    model?: string
    sw_version?: string
    name?: string
}

export type OriginInfo = {
    name: string
    support_url?: string
    sw_version?: string
}

export type AvailabilityInfo = {
    topic: string
    // Home Assistant documents defaults for these two, but a payload that leaves them out reaches
    // the entity with the key missing and setup fails on a KeyError, so we always state them.
    payload_available?: string
    payload_not_available?: string
}

export type ComponentInfo = {
    name?: string | null
    platform: string
    unique_id: string
}

export type DeviceDiscovery = {
    device: DeviceInfo
    origin: OriginInfo
    availability?: AvailabilityInfo[]
    availability_mode?: 'all' | 'any' | 'latest'
    components: Record<string, ComponentInfo>
}

export type ClimateComponent = ComponentInfo & {
    platform: 'climate'
    action_topic?: string
    temperature_unit?: 'C' | 'F'
    temp_step?: number
    precision?: number
    min_temp?: number
    max_temp?: number
    modes?: string[]
    fan_modes?: string[]
    preset_modes?: string[]
    swing_modes?: string[]
    swing_horizontal_modes?: string[]
}

export type HumidifierComponent = ComponentInfo & {
    platform: 'humidifier'
    device_class?: 'humidifier' | 'dehumidifier'
    min_humidity?: number
    max_humidity?: number
    modes?: string[]
    payload_on?: string
    payload_off?: string
    current_humidity_topic?: string
    // remaining per-attribute topics (command_topic/state_topic for power, target_humidity_*,
    // mode_*) are attached dynamically by TLVDevice.addField
}
