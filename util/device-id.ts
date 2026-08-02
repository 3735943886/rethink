/*
 * A device id ends up in a file name, so it is checked before it is used as one. The set below is
 * what the appliances actually use - hex MACs and the cloud's own identifiers - and it contains
 * neither a path separator nor a leading dot, so no id that passes can name a file outside the
 * directory it is joined to.
 */
const DEVICE_ID_RE = /^[A-Za-z0-9._:-]{1,64}$/

export function validDeviceId(deviceId: unknown): deviceId is string {
    return typeof deviceId === 'string' && DEVICE_ID_RE.test(deviceId)
}
