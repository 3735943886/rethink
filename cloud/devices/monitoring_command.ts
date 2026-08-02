// Cloud->appliance commands for the Korean washer/dryer/styler family, the counterpart to
// monitoring_record.ts.
//
// These are the frames the ThinQ app itself sends. Most were recorded with rethink's observe-only
// switch on, so pressing the app's buttons produced the bytes without any appliance carrying the
// command out - a washer's "start" could be read off the wire with the drum standing still.
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

export const CONTROL_POWER_OFF = 0x01
export const CONTROL_PAUSE = 0x04

// Body for AABBDevice.send(), which adds the AA/length prefix and the checksum/BB tail.
export function shortControl(type: number): Buffer {
    return Buffer.from([0xf0, 0x24, type, 0x01, 0x00])
}

export function courseControl(payload: Buffer): Buffer {
    return Buffer.concat([Buffer.from([0xf0, 0x26]), payload])
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
 * - someone turned the dial, or a cycle started - and otherwise stays where it was put. Powering off
 * zeroes the course byte and is ignored, so the selection survives a power cycle.
 */
export class CourseSelection {
    selected = 0
    private reported: number | undefined

    follow(course: number) {
        if (course === this.reported) return
        this.reported = course
        if (course !== 0) this.selected = course
    }

    select(code: number) {
        this.selected = code
    }
}
