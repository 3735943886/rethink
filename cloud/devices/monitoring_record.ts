// The "monitoring record" flavour of the AABB protocol, shared by the Korean washer/dryer/styler
// family (F24VDD, RH14_N_KR, Pd0F_F, S3BF_POD_DN4 - and, with different payload lengths, by the US
// models already supported here).
//
// The appliance reports its whole state as one fixed-length payload, wrapped in a record header:
//
//   0xEC  [dev][EC] [00][len][payload: previous state] [00][len][payload: current state]
//   0xEB  [dev][EB] [00][len][payload: current state]
//   0xE2  [dev][E2] [03][len][payload: current state]
//
// 0xEC is the regular report (~60s while running, ~1h while idle) and stacks the state it last
// reported in front of the current one - verified against the capture: record A is byte-identical to
// the preceding frame's record B on 351 of 353 consecutive pairs, the two exceptions being frames
// either side of a reconnect. 0xEB carries the current state alone and is what the appliance sends
// right after (re)connecting, before it has a previous state to stack.
//
// 0xE2 is the same single record behind a different header byte, sent when a cycle begins: the dryer
// sent one the instant it took a start command, carrying the course and settings that command had just
// asked for. It is rare - three in two days of capture across the family - and decoding it only means
// Home Assistant hears about a cycle a minute earlier than the next 0xEC would have told it.
//
// `buf` is the AABB body: AA+length and checksum+BB are already stripped by AABBDevice.

export function currentRecord(buf: Buffer, devByte: number, payloadLen: number): Buffer | undefined {
    if (buf.length < 4 || buf[0] !== devByte) return undefined

    // The record header is [00][len] - [03][len] on the 0xE2 flavour; both bytes are checked, so a
    // model whose payload length changes under a firmware update reports nothing rather than fields
    // read off the wrong offsets.
    const recordLen = payloadLen + 2
    let start: number
    let header = 0x00
    if (buf[1] === 0xec) {
        if (buf.length !== 2 + 2 * recordLen) return undefined
        start = 2 + recordLen
    } else if (buf[1] === 0xeb || buf[1] === 0xe2) {
        if (buf.length !== 2 + recordLen) return undefined
        start = 2
        if (buf[1] === 0xe2) header = 0x03
    } else {
        return undefined
    }

    if (buf[start] !== header || buf[start + 1] !== payloadLen) return undefined
    return buf.subarray(start + 2)
}
