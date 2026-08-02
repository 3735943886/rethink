import { WebSocketExpress, ExtendedWebSocket } from 'websocket-express'

import path from 'path'
import { fileURLToPath } from 'url'
import log from '@/util/logging'

import HA_bridge from '@/cloud/ha_bridge'
import { AnyDevice, DeviceManager } from '@/cloud/devmgr'
import { Bridge } from '@/bridge'
import { Request, Response } from 'express'
import { Device as T1Device } from '@/cloud/thinq1/device'
import { Device as T2Device } from '@/cloud/thinq2/device'

export function app(ha: HA_bridge, manager: DeviceManager, bridge: Bridge | undefined) {
    const app = new WebSocketExpress()
    let subscribers: ExtendedWebSocket[] = []

    // device management
    function broadcast(message: object) {
        const str = JSON.stringify(message)
        subscribers.forEach((sub) => {
            sub.send(str)
        })
    }

    function statusReport(message: string) {
        broadcast({ status: message })
    }

    app.use(function (req, res, next) {
        log('MGMT', req.hostname, req.url)
        next()
    })
    app.use(WebSocketExpress.json())

    const currentDir = path.dirname(fileURLToPath(import.meta.url))
    app.ws('/ws', (req, res, next) => {
        res.accept().then((ws) => {
            subscribers.push(ws)

            ws.send(
                JSON.stringify({
                    ha: ha.HA.isConnected,
                    bridge: bridgeStatus(),
                    devices: enumDevices(),
                }),
            )

            ws.on('message', (msg) => {})

            ws.on('close', () => {
                subscribers = subscribers.filter((el) => el !== ws)
            })
        }, next)
    })

    ha.HA.on('statusChanged', (ha) => {
        broadcast({ ha })
    })

    function enumDevices() {
        const allDevices: Record<string, any> = {}
        for (const id in manager.allDevices) {
            const dev = manager.allDevices[id]
            const meta = dev.meta
            allDevices[id] = {
                model: meta.modelId,
                deviceType: meta.deviceType,
                platform: dev.platform,
                mapped: ha.haDevices.has(id),
                bridged: bridge ? bridge.status(id) : false,
            }
        }
        return allDevices
    }

    function refreshDevices() {
        broadcast({ devices: enumDevices() })
    }

    function onNewDevice(dev: AnyDevice) {
        refreshDevices()
    }

    manager.on('newDevice', onNewDevice)
    manager.on('dropDevice', refreshDevices)

    if (bridge) {
        app.get(
            '/thinq_login',
            asyncHandler(async (req, res) => {
                res.redirect((await bridge.beginLogin({ countryCode: req.query.countryCode as string })).toString())
            }),
        )

        app.post(
            '/thinq_login_accept',
            asyncHandler(async (req, res) => {
                const url = `${req.body.url}`
                const countryCode = `${req.body.countryCode}`
                if (await bridge.completeLogin({ countryCode }, new URL(url))) {
                    res.statusCode = 200
                    res.end()
                } else {
                    res.statusCode = 400
                    res.end()
                }
            }),
        )

        app.post(
            '/thinq_logout',
            asyncHandler(async (req, res) => {
                await bridge.logout()
                res.end()
            }),
        )

        app.post(
            '/bridge/:deviceId/enable',
            asyncHandler(async (req, res) => {
                const deviceType = typeof req.body.deviceType === 'string' ? (req.body.deviceType as string) : undefined
                try {
                    if (await bridge.enable(req.params.deviceId, deviceType, statusReport)) res.status(204).end()
                    else res.status(400).end()
                } catch (err) {
                    res.status(500).end(`${err}`)
                }
            }),
        )

        app.post(
            '/bridge/:deviceId/disable',
            asyncHandler(async (req, res) => {
                await bridge.disable(req.params.deviceId)
                res.status(204).end()
            }),
        )

        function refreshBridgeStatus() {
            broadcast({ bridge: bridgeStatus() })
        }

        bridge.on('loggedIn', refreshBridgeStatus)
        bridge.on('loggedOut', refreshBridgeStatus)
        bridge.on('started', refreshDevices)
        bridge.on('stopped', refreshDevices)
    }

    function bridgeStatus() {
        if (bridge) return { loggedIn: bridge.isLoggedIn() }
    }

    // device monitoring
    app.ws('/device', (req, res, next) => {
        const id = req.query?.id
        if (typeof id !== 'string') {
            res.status(400).end()
            return
        }

        res.accept().then((ws) => {
            let injectFlag = false
            let device: AnyDevice | undefined
            // Kept here as well as on the device, so that an appliance which reconnects mid-experiment
            // comes back observe-only instead of silently accepting the next command from the cloud.
            let blockToDevice = false
            const onDeviceRx = (arg: Buffer) => {
                ws.send(JSON.stringify({ rx: arg.toString('hex'), injected: injectFlag }))
            }

            const onDeviceTx = (arg: Buffer | object) => {
                if (Buffer.isBuffer(arg)) ws.send(JSON.stringify({ tx: arg.toString('hex'), injected: injectFlag }))
                else ws.send(JSON.stringify({ tx: JSON.stringify(arg), injected: injectFlag }))
            }

            const checkDevicePresence = () => {
                const dev = manager.allDevices[id]

                if (dev !== device) {
                    device?.removeListener('data', onDeviceRx)
                    device?.removeListener('sendData', onDeviceTx)

                    device = dev
                    if (device) {
                        if (device instanceof T2Device) device.blockToDevice = blockToDevice
                        ws.send(JSON.stringify({ status: 'online', meta: device.meta, blockToDevice }))
                        device.on('data', onDeviceRx)
                        device.on('sendData', onDeviceTx)
                    } else {
                        ws.send(JSON.stringify({ status: 'offline' }))
                    }
                }
            }

            manager.on('newDevice', checkDevicePresence)
            manager.on('dropDevice', checkDevicePresence)

            checkDevicePresence()

            ws.on('message', (msg) => {
                if (!Buffer.isBuffer(msg)) return

                let json: any
                try {
                    json = JSON.parse(msg.toString('utf-8'))
                } catch {
                    return
                }
                const dev = manager.allDevices[id]

                try {
                    /*
                     * Observe-only: hold back everything the cloud addresses to this appliance, while
                     * still reporting it here. This is how the ThinQ app's own control frames get
                     * recorded without the appliance carrying the command out - press "start" in the
                     * app, keep the bytes, and the machine stays put. Off by default, and it lasts
                     * only as long as this monitor connection asks for it.
                     */
                    if (typeof json.blockToDevice === 'boolean') {
                        blockToDevice = json.blockToDevice
                        if (dev instanceof T2Device) dev.blockToDevice = blockToDevice
                        log('MGMT', id, `observe-only ${blockToDevice ? 'on' : 'off'}`)
                        ws.send(JSON.stringify({ blockToDevice }))
                    }

                    if (typeof json.sendToDevice === 'object' && dev && dev instanceof T1Device) {
                        try {
                            injectFlag = true
                            dev.send(json.sendToDevice)
                        } finally {
                            injectFlag = false
                        }
                    }

                    if (typeof json.sendToDevice === 'string' && dev && dev instanceof T2Device) {
                        try {
                            injectFlag = true
                            dev.send_packet(Buffer.from(json.sendToDevice, 'hex'))
                        } finally {
                            injectFlag = false
                        }
                    }

                    if (json.sendFromDevice && dev) {
                        try {
                            injectFlag = true
                            dev.emit('data', Buffer.from(json.sendFromDevice, 'hex'))
                        } finally {
                            injectFlag = false
                        }
                    }

                    /*
                     * The two injections above are packets - the payload an
                     * appliance carries inside cmd `device_packet`. The clip cmds that wrap them
                     * (`check_mfota`, `reqUniversalCtrl`, ...) had no injection path at all, so the
                     * only way to exercise one was to make the appliance or the cloud emit it and
                     * wait: 12h for a firmware check, or a press of "update" in the ThinQ app.
                     *
                     * sendClipToDevice   {cmd, type, data} - as if the cloud had sent it
                     * sendClipFromDevice {cmd, type, data} - as if the appliance had sent it; goes
                     *                    to the bridge, and so to the real cloud, exactly as an
                     *                    unhandled cmd off the wire does. Still subject to the
                     *                    bridge's own refusal to relay the provisioning verbs.
                     */
                    if (typeof json.sendClipToDevice === 'object' && dev && dev instanceof T2Device) {
                        const clip = json.sendClipToDevice
                        log('MGMT', id, `injecting clip to device: ${JSON.stringify(clip)}`)
                        dev.send(clip.cmd, clip.type ?? 0, clip.data ?? {})
                    }

                    if (typeof json.sendClipFromDevice === 'object' && dev && dev instanceof T2Device) {
                        const clip = json.sendClipFromDevice
                        log('MGMT', id, `injecting clip from device: ${JSON.stringify(clip)}`)
                        if (!dev.onUnhandledClip) ws.send(JSON.stringify({ error: 'device is not bridged' }))
                        dev.onUnhandledClip?.({ ...clip, did: id })
                    }
                } catch (err) {
                    log('MGMT', id, `inject error: ${err}`)
                }
            })

            ws.on('close', () => {
                manager.removeListener('newDevice', checkDevicePresence)
                manager.removeListener('dropDevice', checkDevicePresence)
            })
        }, next)
    })

    // static pages
    app.use(WebSocketExpress.static(currentDir + '/../html', { extensions: ['html'] }))
    return app.createServer()
}

function asyncHandler(handler: (req: Request, res: Response) => Promise<any>) {
    return (req: Request, res: Response, next: (err: any) => void) => {
        handler(req, res).catch(next)
    }
}
