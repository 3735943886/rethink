import * as mqtt from 'mqtt'
import { Thinq2Device } from './thinqApi'
import { TypedEmitter } from 'tiny-typed-emitter'
import log from '@/util/logging'
import { type ClipEnvelope } from '@/cloud/thinq2/clip'

// No 'data' event: a packet from the cloud is a clip message like any other and goes to onCloudClip
// with its envelope intact, rather than being unwrapped here and rebuilt on the far side.
type ConnectionEvents = {
    close: () => void
    error: (error: Error) => void
}

export type ClipPayload = ClipEnvelope

/*
 * Cmds that must never cross the bridge, in either direction.
 *
 * This was an allow list holding only `check_mfota`, and that turned out to be too narrow to learn
 * anything from. Pressing "update" in the ThinQ app makes the cloud ask the appliance whether it is
 * there at all - `reqUniversalCtrl` with `reqType: online_check` - before it offers any firmware.
 * That was dropped here, so from the cloud's side the appliance is simply offline and the exchange
 * ends before it starts.
 *
 * Relaying the question is only half of it; the appliance's answer has to reach the cloud as well.
 * Asking a real appliance directly (tools/clip-probe.ts) shows what that answer is: it replies
 * `respUniversalCtrl` within about 100ms, echoing reqType/messageId/clientId - which is what the
 * cloud correlates on - and adding `responseCode: "0000"`. So both cmds have to cross, in opposite
 * directions, and an allow list has to be right about a name before it has been observed.
 *
 * So: carry anything, except the handful that would do damage. Those are the provisioning verbs.
 * `undeploy` in particular could tear down the registration this whole branch exists to preserve,
 * and the deploy pair is already handled on both sides - replaying it would fight that handling.
 * Everything else an appliance emits is a report or an answer.
 *
 * `check_mfota` is the other half of the firmware path: the appliance raises it on a schedule it
 * carries in the message (`check_mfota_period`, 12h on the units that have it enabled).
 */
const NEVER_RELAYED_CMDS = ['undeploy', 'deploy', 'preDeploy', 'completeProvisioning', 'completeProvisioning_ack']

export function isRelayable(cmd: string) {
    return !NEVER_RELAYED_CMDS.includes(cmd)
}

/**
 * What a bridged appliance tells the cloud about itself when it introduces itself.
 *
 * Three levels, in order: what the appliance is reporting right now, what it reported when it was
 * registered, and a fixed set of placeholders. The placeholders describe an HNA device rather than
 * the appliance in the room - protocolVer in particular, which decides how the cloud frames its
 * reservation polls - so they are a last resort, for a state written before either of the first two
 * was recorded.
 */
export function deployInfo(
    device: Thinq2Device,
    liveAppInfo?: Record<string, unknown>,
    livePlatformInfo?: Record<string, unknown>,
) {
    const state = device.state!
    return {
        appInfo: liveAppInfo ??
            state.deployAppInfo ?? {
                modelName: device.meta.modelName,
                modelLanguage: state.countryCode,
                softVer: '690409',
                ruleVer: '2.0.11',
                countryCode: state.countryCode,
                subCountryCode: state.countryCode,
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
        platformInfo: livePlatformInfo ??
            state.deployPlatformInfo ?? {
                provisioningKey: device.meta.modelName,
                version: 'clip_v2.00.15.05-RTK_RTL8711am-SDK-8-RELEASE',
            },
    }
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
                if (topic === this.device.state!.subTopic) {
                    const payload = JSON.parse(message.toString('utf-8'))
                    if (payload.cmd === 'completeProvisioning') {
                        //msgtopic=payload.data.appInfo.publication.message
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
                        this.onCloudClip?.(payload as ClipPayload)
                    } else if (payload.cmd !== 'completeProvisioning') {
                        // completeProvisioning is answered above and goes no further; everything else
                        // is carried to the appliance as it stands, or logged as refused.
                        const relayed = isRelayable(payload.cmd)
                        log('bridge', `${this.device.deviceId} <- ${relayed ? 'relay' : 'refused'} ${payload.cmd}`)
                        if (relayed) this.onCloudClip?.(payload as ClipPayload)
                    }
                }
            } catch (err) {
                console.log(err)
            }
        })

        /*
         * Both awaits below can reject - a subscribe is what AWS IoT refuses when its policy does not
         * cover the topic, and that has happened here before. An async listener that rejects raises an
         * unhandled rejection, which Node answers by killing the process: one appliance's bad subscribe
         * would take rethink down for every other appliance with it. Route it through the connection's
         * own error path instead, where the bridge already knows how to drop the connection and try
         * again in five seconds.
         */
        this.mqtt.on('connect', () => {
            log('bridge', `${this.device.deviceId} connected`)
            this.announce().catch((err) => {
                log('bridge', `${this.device.deviceId} could not announce itself: ${err}`)
                this.emit('error', err instanceof Error ? err : new Error(String(err)))
                this.mqtt.end()
            })
        })

        this.mqtt.on('close', () => this.emit('close'))
        this.mqtt.on('error', (err) => this.emit('error', err))
    }

    // Subscribe to what the cloud sends this appliance, then introduce the appliance to it.
    async announce() {
        await this.mqtt.subscribeAsync(this.device.state!.subTopic)
        await this.mqtt.publishAsync(
            this.device.state!.provTopic,
            JSON.stringify({
                mid: ++this.mid,
                did: this.device.deviceId,
                kind: this.device.meta.modelName,
                cmd: 'preDeploy',
                rssi: -48,
                fs: 'idle',
                data: deployInfo(this.device, this.deployAppInfo, this.deployPlatformInfo),
                type: 0,
            }),
            { qos: 1 },
        )
    }

    /* Called with the cloud's answer to a relayed cmd. See Device.onUnhandledClip. */
    onCloudClip?: (payload: ClipPayload) => void

    /*
     * Put a message from the appliance in front of the real cloud as it stands.
     * The appliance's own fields are kept - an answer to `reqUniversalCtrl` carries the cloud's
     * `messageId` back in `data`, which is what the cloud correlates on - and only the envelope
     * this connection owns is rewritten.
     */
    sendClip(payload: ClipPayload) {
        if (!isRelayable(payload.cmd)) return

        log('bridge', `${this.device.deviceId} -> relay ${payload.cmd}`)
        this.mqtt.publish(
            this.device.state!.pubTopic,
            JSON.stringify({
                ...payload,
                mid: ++this.mid,
                did: this.device.deviceId,
                kind: this.device.meta.modelName,
            }),
            { qos: 1 },
        )
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
