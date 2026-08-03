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
    const subscribers = new Set<ExtendedWebSocket>()
    const deviceMonitors = new Map<ExtendedWebSocket, () => void>()
    const disposers: Array<() => void> = []
    let shuttingDown = false

    function closeQuietly(ws: ExtendedWebSocket) {
        try {
            ws.close()
        } catch {}
    }

    function safeSend(ws: ExtendedWebSocket, message: string) {
        if (ws.readyState !== ws.OPEN) return false
        try {
            ws.send(message, (error) => {
                if (error) {
                    subscribers.delete(ws)
                    closeQuietly(ws)
                }
            })
            return true
        } catch {
            subscribers.delete(ws)
            closeQuietly(ws)
            return false
        }
    }

    // device management
    function broadcast(message: object) {
        const str = JSON.stringify(message)
        subscribers.forEach((sub) => safeSend(sub, str))
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
            if (shuttingDown) {
                closeQuietly(ws)
                return
            }
            subscribers.add(ws)

            safeSend(
                ws,
                JSON.stringify({
                    ha: ha.HA.isConnected,
                    bridge: bridgeStatus(),
                    devices: enumDevices(),
                }),
            )

            ws.on('message', (msg) => {})

            ws.on('close', () => {
                subscribers.delete(ws)
            })
        }, next)
    })

    const onHaStatusChanged = (ha: boolean) => {
        broadcast({ ha })
    }
    ha.HA.on('statusChanged', onHaStatusChanged)
    disposers.push(() => ha.HA.removeListener('statusChanged', onHaStatusChanged))

    function enumDevices() {
        const allDevices: Record<string, any> = {}
        for (const id in manager.allDevices) {
            const dev = manager.allDevices[id]
            const meta = dev.meta
            allDevices[id] = {
                // What the owner calls it, when the bridge has been able to ask the account
                name: bridge?.name(id),
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
    disposers.push(() => {
        manager.removeListener('newDevice', onNewDevice)
        manager.removeListener('dropDevice', refreshDevices)
    })

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
        bridge.on('namesChanged', refreshDevices)
        disposers.push(() => {
            bridge.removeListener('loggedIn', refreshBridgeStatus)
            bridge.removeListener('loggedOut', refreshBridgeStatus)
            bridge.removeListener('started', refreshDevices)
            bridge.removeListener('stopped', refreshDevices)
            bridge.removeListener('namesChanged', refreshDevices)
        })
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
            if (shuttingDown) {
                closeQuietly(ws)
                return
            }
            let injectFlag = false
            let device: AnyDevice | undefined
            /*
             * The appliance owns its observe-only state; this only remembers whether *this* connection
             * asked for it, so that it can be re-applied to a device object that gets replaced by a
             * reconnect. A connection that never touched the switch must not write to it at all -
             * having every newly opened monitor page assert its own default is how a page being opened
             * silently lifted the block on an appliance that another connection was holding, and a
             * command went through to the hardware.
             */
            let blockRequested: boolean | undefined
            const onDeviceRx = (arg: Buffer) => {
                safeSend(ws, JSON.stringify({ rx: arg.toString('hex'), injected: injectFlag }))
            }

            const onDeviceTx = (arg: Buffer | object) => {
                if (Buffer.isBuffer(arg))
                    safeSend(ws, JSON.stringify({ tx: arg.toString('hex'), injected: injectFlag }))
                else safeSend(ws, JSON.stringify({ tx: JSON.stringify(arg), injected: injectFlag }))
            }

            const checkDevicePresence = () => {
                const dev = manager.allDevices[id]

                if (dev !== device) {
                    device?.removeListener('data', onDeviceRx)
                    device?.removeListener('sendData', onDeviceTx)

                    device = dev
                    if (device) {
                        if (device instanceof T2Device && blockRequested !== undefined)
                            device.blockToDevice = blockRequested
                        // Reported, never assumed: the switch shown here is the appliance's own state,
                        // so a page that is opened or reloaded sees what is actually in force.
                        const blockToDevice = device instanceof T2Device && device.blockToDevice
                        safeSend(ws, JSON.stringify({ status: 'online', meta: device.meta, blockToDevice }))
                        device.on('data', onDeviceRx)
                        device.on('sendData', onDeviceTx)
                    } else {
                        safeSend(ws, JSON.stringify({ status: 'offline' }))
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
                        const wanted: boolean = json.blockToDevice
                        blockRequested = wanted
                        if (dev instanceof T2Device) dev.blockToDevice = wanted
                        log('MGMT', id, `observe-only ${wanted ? 'on' : 'off'}`)
                        // Echoed from the appliance, so an "on" that reached nothing - the device is
                        // offline, or is a thinq1 device the switch does not cover - reads as off here
                        // rather than as a block that is not in force.
                        ws.send(JSON.stringify({ blockToDevice: dev instanceof T2Device && dev.blockToDevice }))
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

            /*
             * The appliance's own listeners have to go too, not just the manager's. They were left
             * attached, so every monitor page that had ever been opened went on forwarding that
             * appliance's traffic into a socket that was already closed - and an appliance that stays
             * connected for days collects one such pair per page view. Only a reconnect cleared them,
             * by replacing the Device object they were attached to.
             *
             * Guarded by the deviceMonitors entry rather than run unconditionally: 'close' and
             * 'error' both arrive on a socket that failed, and the second one must not detach the
             * listeners of whatever has since been attached.
             */
            const cleanup = () => {
                if (!deviceMonitors.delete(ws)) return
                device?.removeListener('data', onDeviceRx)
                device?.removeListener('sendData', onDeviceTx)
                device = undefined
                manager.removeListener('newDevice', checkDevicePresence)
                manager.removeListener('dropDevice', checkDevicePresence)
            }
            deviceMonitors.set(ws, cleanup)
            ws.once('close', cleanup)
            ws.once('error', cleanup)
        }, next)
    })

    // static pages
    app.use(WebSocketExpress.static(currentDir + '/../html', { extensions: ['html'] }))
    const server = app.createServer()

    const dispose = () => {
        if (shuttingDown) return
        shuttingDown = true
        for (const dispose of disposers.splice(0)) dispose()
        for (const subscriber of subscribers) closeQuietly(subscriber)
        subscribers.clear()
        for (const [monitor, cleanup] of deviceMonitors) {
            cleanup()
            closeQuietly(monitor)
        }
        deviceMonitors.clear()
    }

    const close = server.close.bind(server)
    server.close = ((callback?: (err?: Error) => void) => {
        dispose()
        return close(callback)
    }) as typeof server.close
    server.once('close', dispose)
    return server
}

function asyncHandler(handler: (req: Request, res: Response) => Promise<any>) {
    return (req: Request, res: Response, next: (err: any) => void) => {
        handler(req, res).catch(next)
    }
}
