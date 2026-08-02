// Cloud->appliance commands for the Korean washer/dryer/styler family, the counterpart to
// monitoring_record.ts.
//
// These are the frames the ThinQ app itself sends. They were recorded with rethink's observe-only
// switch on, so pressing the app's buttons produced the bytes without any appliance carrying the
// command out - a washer's "start" could be read off the wire with the drum standing still.
//
//   f0 24 <type> 01 00      short control: type 1 = power off, type 4 = pause
//   f0 26 <payload>         start a course - or resume a paused one
//   f0 25 <type> <len> ...  download a course into the appliance's slot (not sent by rethink)
//
// The payload mirrors the status record: same field order, and the option bytes use the same bit
// masks - so a handler encodes a command with the tables it already has for decoding one. The two
// families differ in how they say "resume rather than restart": the washer and the mini washer send
// the ordinary start payload with the initialBit flag cleared, while the styler sends a shorter
// payload that leaves out the download-slot field entirely.

export const CONTROL_POWER_OFF = 0x01
export const CONTROL_PAUSE = 0x04

// Body for AABBDevice.send(), which adds the AA/length prefix and the checksum/BB tail.
export function shortControl(type: number): Buffer {
    return Buffer.from([0xf0, 0x24, type, 0x01, 0x00])
}

export function courseControl(payload: Buffer): Buffer {
    return Buffer.concat([Buffer.from([0xf0, 0x26]), payload])
}
