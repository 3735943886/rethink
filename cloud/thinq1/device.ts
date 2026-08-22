import { TypedEmitter } from 'tiny-typed-emitter'
import { Duplex } from 'node:stream'
import { Connection } from './connection'
import { getDeviceMetadata } from './http'
import { Metadata } from '../thinq'
import { randomUUID } from 'node:crypto'

type ConWithExtra = Connection & {
    deviceObj?: Device
}

type DeviceEvents = {
    data: (packet: Buffer) => void
    response: (body: Record<string, unknown>) => void
    sendData: (body: object) => void
    close: () => void
}

// Some ThinQ 1 appliances (observed on air purifiers) open a second RTI socket for the same
// device id alongside the first instead of replacing it. Both stay under this one Device so
// neither socket is mistaken for a stale reconnect; outbound commands go out the most recently
// added (and presumably still-live) socket.
export class Device extends TypedEmitter<DeviceEvents> {
    readonly platform = 'thinq1'

    lastReport: Buffer | undefined
    private readonly connections = new Set<ConWithExtra>()
    private activeConnection: ConWithExtra | undefined

    constructor(
        con: ConWithExtra,
        readonly id: string,
        readonly meta: Metadata,
    ) {
        super()
        this.addConnection(con)
    }

    addConnection(con: ConWithExtra) {
        if (this.connections.has(con)) return

        this.connections.add(con)
        this.activeConnection = con
        con.deviceObj = this
        con.on('status', (packet) => {
            this.lastReport = packet
            this.emit('data', packet)
        })
        con.on('response', (body) => this.emit('response', body))
        con.on('error', console.log)
        con.on('close', () => {
            if (con.deviceObj === this) {
                con.deviceObj = undefined
                this.connections.delete(con)
                if (this.activeConnection === con) {
                    const remainingConnections = Array.from(this.connections)
                    this.activeConnection = remainingConnections[remainingConnections.length - 1]
                }
                if (this.connections.size === 0) this.emit('close')
            }
        })
    }

    send(body: object) {
        this.emit('sendData', body)
        this.activeConnection?.json({
            Header: { 'x-lgedm-deviceId': this.id },
            Body: {
                ...body,
                CmdWId: `n-${randomUUID()}`,
            },
        })
    }
}

type DeviceAcceptorEvents = {
    newDevice: (dev: Device) => void
    dropDevice: (id: string) => void
}

export class DeviceAcceptor extends TypedEmitter<DeviceAcceptorEvents> {
    devicesById: Record<string, Device> = {}
    constructor(readonly metadataFor: (id: string) => Metadata | undefined = getDeviceMetadata) {
        super()
    }

    accept(socket: Duplex) {
        const con = new Connection(socket) as ConWithExtra
        con.on('error', () => {}) // ignore errors at this stage
        con.on('init', (deviceId) => {
            const meta = this.metadataFor(deviceId)
            if (!meta) {
                console.warn(`device ${deviceId} metadata not known, send HTTP POST first!`)
                con.destroy()
                return
            }

            const existingDevice = this.devicesById[deviceId]
            if (existingDevice) {
                console.log(`device ${deviceId} opened an additional connection`)
                con.removeAllListeners('error')
                existingDevice.addConnection(con)
                return
            }

            con.removeAllListeners('error')
            const dev = new Device(con, deviceId, meta)
            this.devicesById[deviceId] = dev
            dev.on('close', () => {
                if (this.devicesById[deviceId] === dev) {
                    delete this.devicesById[deviceId]
                    this.emit('dropDevice', deviceId)
                }
            })

            this.emit('newDevice', dev)
        })
    }
}
