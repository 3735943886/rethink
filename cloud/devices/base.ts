import { type Metadata } from '../thinq'
import type { Connection, DeviceDiscovery } from '../homeassistant'

export default class HADevice {
    config: DeviceDiscovery | undefined

    static config(meta: Metadata, deviceInfo?: object): DeviceDiscovery {
        return {
            // The payloads are spelled out rather than left to Home Assistant's defaults, which are
            // the same two words. A discovery payload that omits them reaches the entity with the
            // key missing and setup dies on a KeyError - the defaults are not always filled in.
            availability: [
                { topic: '$this/availability', payload_available: 'online', payload_not_available: 'offline' },
                { topic: '$rethink/availability', payload_available: 'online', payload_not_available: 'offline' },
            ],
            availability_mode: 'all',
            device: {
                identifiers: '$deviceid',
                manufacturer: 'LG',
                model: meta.modelName,
                sw_version: meta.swVersion,
                ...(deviceInfo || {}),
            },
            origin: {
                name: 'rethink',
                support_url: 'https://github.com/anszom/rethink',
            },
            components: {},
        }
    }

    constructor(
        readonly HA: Connection,
        readonly id: string,
    ) {}

    setConfig(config: DeviceDiscovery) {
        this.config = config
        this.publishConfig()
    }

    drop() {
        this.cancelPendingWork()
        this.HA.publishProperty(this.id, 'availability', 'offline')
    }

    /*
     * Releases timers and listeners a subclass is holding, without touching HA's availability
     * state. drop() always calls this on its way to publishing offline, but it also runs on its
     * own when a device is superseded by its own replacement before its close event fires - see
     * Bridge.newDevice() - where publishing offline would only be a flicker, since the
     * replacement is about to publish online under the same id.
     */
    cancelPendingWork() {}

    start() {}

    // HA-side
    publishConfig() {
        if (this.config) {
            this.HA.publishProperty(this.id, 'availability', 'online')
            this.HA.publishConfig(this.id, this.config)
        }
    }

    setProperty(prop: string, mqttValue: string) {
        throw new Error('To be overriden')
    }
}
