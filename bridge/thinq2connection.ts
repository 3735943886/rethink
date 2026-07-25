import * as mqtt from 'mqtt'
import { Thinq2Device } from './thinqApi'
import { TypedEmitter } from 'tiny-typed-emitter'
import log from '@/util/logging'

type ConnectionEvents = {
    data: (buffer: Buffer) => void
    close: () => void
    error: (error: Error) => void
}

export class Connection extends TypedEmitter<ConnectionEvents> {
    mqtt: mqtt.MqttClient
    mid = 10000

    constructor(
        readonly device: Thinq2Device,
        // The physical device's real deploy appInfo/platformInfo (from cloud/thinq2 Device).
        // Forwarded upstream verbatim so the cloud sees the true protocolVer/softVer/etc.
        // Falls back to placeholders below when unavailable (device not yet deployed).
        readonly deployAppInfo?: Record<string, unknown>,
        readonly deployPlatformInfo?: Record<string, unknown>,
    ) {
        super()
        const state = this.device.state!
        log('bridge', `${this.device.deviceId} connecting to ${state.mqttServer}`)
        this.mqtt = mqtt.connect(state.mqttServer.replace('ssl', 'mqtts'), {
            ca: state.caCertificate,
            key: state.privateKey,
            cert: state.certificate,
            clientId: this.device.deviceId,
            reconnectPeriod: 0, // no auto-reconnect
        })

        this.mqtt.on('message', (topic, message, packet) => {
            try {
                // DIAGNOSTIC: the service channel (subscription.service.appliance) carries "service"
                // commands like reservation. Log what arrives so we can build the relay from real data.
                if (topic === this.device.state!.serviceSubTopic) {
                    log('bridge', `${this.device.deviceId} SVC <- ${message.toString('utf-8')}`)
                }
                if (topic === this.device.state!.subTopic) {
                    const payload = JSON.parse(message.toString('utf-8'))
                    if (payload.cmd === 'completeProvisioning') {
                        //msgtopic=payload.data.appInfo.publication.message
                        // DIAGNOSTIC: capture how the real cloud provisions the device's channels
                        // (message/service/control publication+subscription). We mirror this in
                        // cloud/thinq2/provisioning.ts generateDeployResponse to see whether giving
                        // the device the service channel enables reservation ("service") handling.
                        log('bridge', `${this.device.deviceId} completeProvisioning <- ${message.toString('utf-8')}`)
                        this.mqtt.publish(
                            this.device.state!.pubTopic,
                            JSON.stringify({
                                mid: ++this.mid,
                                did: this.device.deviceId,
                                kind: this.device.meta.modelName,
                                cmd: 'completeProvisioning_ack',
                                rssi: -48,
                                fs: 'idle',
                                data: null,
                                type: 1,
                            }),
                        )
                    }

                    if (payload.cmd === 'packet') {
                        log('bridge', `${this.device.deviceId} <- ${payload.data}`)
                        this.emit('data', Buffer.from(payload.data, 'hex'))
                    }
                }
            } catch (err) {
                console.log(err)
            }
        })

        this.mqtt.on('connect', async () => {
            log('bridge', `${this.device.deviceId} connected`)
            await this.mqtt.subscribe(this.device.state!.subTopic)
            // Subscribe to the exact (LG-authorized) service topic if we have it. This is a single
            // named topic from the device's own CertResponse, NOT a wildcard, so it won't trip the
            // broker ACL. A subscribe failure is logged but must not tear down the connection.
            const serviceSubTopic = this.device.state!.serviceSubTopic
            if (serviceSubTopic) {
                this.mqtt.subscribe(serviceSubTopic, (err) =>
                    log(
                        'bridge',
                        err
                            ? `${this.device.deviceId} service sub failed: ${err.message}`
                            : `${this.device.deviceId} subscribed service ${serviceSubTopic}`,
                    ),
                )
            }
            await this.mqtt.publish(
                this.device.state!.provTopic,
                JSON.stringify({
                    mid: ++this.mid,
                    did: this.device.deviceId,
                    kind: this.device.meta.modelName,
                    cmd: 'preDeploy',
                    rssi: -48,
                    fs: 'idle',
                    // Prefer the physical device's real appInfo/platformInfo so the cloud sees
                    // its true protocolVer/softVer/etc. Reporting a placeholder protocolVer made
                    // the cloud send reservation ("service") polls in a wire framing the firmware
                    // ignores. Fall back to placeholders only if the device hasn't deployed yet.
                    data: {
                        appInfo: this.deployAppInfo ??
                            this.device.state!.deployAppInfo ?? {
                                modelName: this.device.meta.modelName,
                                modelLanguage: this.device.state!.countryCode,
                                softVer: '690409',
                                ruleVer: '2.0.11',
                                countryCode: this.device.state!.countryCode,
                                subCountryCode: this.device.state!.countryCode,
                                appVersion: 'clip_hna_v1.9.183',
                                modemType: 'RTK_RTL8711am',
                                regionalCode: 'eic',
                                timezone: '+0100',
                                svcCode: 'SVC202',
                                HomeApSsid: 'whatever',
                                DeviceType: '',
                                ruleEngine: 'y',
                                protocolVer: '1',
                                oneshot: 'y',
                                size: 1572864,
                                fwUpgradeInfo: {
                                    upgSched: {
                                        cmd: 'none',
                                        upgUtc: '0',
                                    },
                                },
                            },
                        platformInfo: this.deployPlatformInfo ??
                            this.device.state!.deployPlatformInfo ?? {
                                provisioningKey: this.device.meta.modelName,
                                version: 'clip_v2.00.15.05-RTK_RTL8711am-SDK-8-RELEASE',
                            },
                    },
                    type: 0,
                }),
                { qos: 1 },
            )
        })

        this.mqtt.on('close', () => this.emit('close'))
        this.mqtt.on('error', (err) => this.emit('error', err))
    }

    send(data: string | Buffer) {
        if (Buffer.isBuffer(data)) data = data.toString('hex').toUpperCase()

        log('bridge', `${this.device.deviceId} -> ${data}`)
        this.mqtt.publish(
            this.device.state!.pubTopic,
            JSON.stringify({
                mid: ++this.mid,
                did: this.device.deviceId,
                kind: this.device.meta.modelName,
                cmd: 'device_packet',
                rssi: -48,
                fs: 'idle',
                data,
                type: 1,
            }),
        )
    }

    destroy() {
        this.mqtt.end()
    }
}
