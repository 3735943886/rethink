// Cloud->appliance commands for the Korean washer/dryer/styler family, the counterpart to
// monitoring_record.ts.
//
// These are the frames the ThinQ app itself sends. Most were read off the wire while rethink held
// them back instead of passing them on, so pressing the app's buttons produced the bytes without any
// appliance carrying the command out - a washer's "start" recorded with the drum standing still.
// That switch has since been removed; anything re-derived now runs on the hardware for real.
//
//   f0 24 <type> 01 00      short control: type 1 = power off, type 4 = pause
//   f0 26 <payload>         start a course - or resume a paused one
//   f0 25 <type> <len> ...  download a course into the appliance's slot (not sent by rethink)
//
// The payload is the appliance's ControlWifi field list laid out in order, one byte per field,
// except that the boolean options are bit-packed - with the same masks the status record uses, so a
// handler encodes a command with the tables it already has for decoding one. Each handler builds its
// own payload; what they share is the framing here and the shape of the exercise:
//
//   - the settings a course runs with (soil level, spin, water temperature, dry level, ...) travel in
//     the start command, not in a separate "set" command. The appliance is told the whole cycle at
//     once, which is why every handler carries a table of per-course defaults,
//   - "resume" is the same frame as "start" with the initialBit option cleared. The styler is the
//     exception: it resumes with a shorter payload that leaves out the download-slot field.
//
// The layouts were confirmed against the model JSON, which agrees on every course this family was
// caught starting: the washer's Colour Care, Heavy Duty and Steam Refresh, the dryer's Cotton Normal,
// the mini washer's Small Load and the styler's Fine Dust all encode byte for byte as captured.

import log from '@/util/logging'

export const CONTROL_POWER_OFF = 0x01
export const CONTROL_PAUSE = 0x04

// Body for AABBDevice.send(), which adds the AA/length prefix and the checksum/BB tail.
export function shortControl(type: number): Buffer {
    return Buffer.from([0xf0, 0x24, type, 0x01, 0x00])
}

export function courseControl(payload: Buffer): Buffer {
    return Buffer.concat([Buffer.from([0xf0, 0x26]), payload])
}

/*
 * Every command this family accepts is answered, about a second later, with a four-byte frame:
 *
 *   [device] 00 <the command byte> <status>      status 0 = taken, 0xff = refused
 *
 * Confirmed across all four appliances and every command type - 0x24, 0x25, 0x26 and even the cloud's
 * weather push 0x66. The refusals are real and informative: this washer answered 0xff to a power-off
 * three separate times, each while it had nothing to power off.
 *
 * "Taken" is as much as a zero status says, and it is worth less than it looks. The styler answers 0
 * to a short control carrying a type of 0x7f, which means nothing at all, and to two more its model
 * JSON does not implement - and then does nothing about any of them. So a zero is the appliance saying
 * the frame arrived and was well formed, not that it understood it. Proving a command does something
 * needs the state the appliance reports afterwards, not its acknowledgement.
 *
 * The absence of an answer is worth as much as its presence. A command that goes unanswered is one the
 * appliance never saw, and the cloud retries it three times at five-second intervals - a triple in the
 * capture with no answer between is a frame that never reached the hardware. A frame with a
 * length byte that does not match its own length is not answered either: four such went out during the
 * probe above and every one was ignored.
 */
export function commandAck(buf: Buffer, devByte: number): { command: number; refused: boolean } | undefined {
    if (buf.length !== 4 || buf[0] !== devByte || buf[1] !== 0x00) return undefined
    return { command: buf[2], refused: buf[3] !== 0 }
}

// Says so in the log and reports whether the frame was an answer, so a handler can stop looking at it.
// Nothing is published: an appliance that refuses a command does not change state, and an entity that
// reported the refusal would have nothing to change back to.
export function reportCommandAck(buf: Buffer, devByte: number, id: string): boolean {
    const ack = commandAck(buf, devByte)
    if (!ack) return false

    const command = `0x${ack.command.toString(16)}`
    log('status', id, ack.refused ? `command ${command} refused by the appliance` : `command ${command} accepted`)
    return true
}

// Turns the name Home Assistant sends back into the wire code, using the table the handler already
// publishes states with - so a select entity's options and its command speak the same language.
export function codeOf(table: Record<number, string>, name: string): number | undefined {
    const found = Object.entries(table).find(([, value]) => value === name)
    return found ? Number(found[0]) : undefined
}

/*
 * The course a start command names.
 *
 * The appliance has no notion of a pending course: its record reports where the dial sits, and that
 * only moves when someone turns it. A start command has to name one anyway, so the handler keeps a
 * selection of its own - seeded from the appliance, changed from Home Assistant.
 *
 * It follows the dial rather than mirroring it. Mirroring would work for exactly one status report:
 * every report repeats the same dial position, so a course picked in Home Assistant would be undone
 * a few seconds later. Following means the selection changes when the appliance's own course changes
 * - someone turned the dial, or a cycle started - and otherwise stays where it was put.
 *
 * It only ever holds a course the handler can actually start. A dial has positions a start command
 * cannot express - the washer's "Downloaded course", the styler's timed indoor dries - and a Home
 * Assistant select rejects a state that is not one of the options it was given, so following those
 * blindly turns every status report into an "Invalid option" error. Powering off, which zeroes the
 * course byte, is ignored by the same rule, so the selection survives a power cycle.
 */
export class CourseSelection {
    selected = 0
    private reported: number | undefined

    // Keyed by course code - the handler's own table of what it knows how to start.
    constructor(private readonly startable: Record<number, unknown>) {}

    follow(course: number) {
        if (course === this.reported) return
        this.reported = course
        if (course in this.startable) this.selected = course
    }

    select(code: number) {
        if (code in this.startable) this.selected = code
    }
}
