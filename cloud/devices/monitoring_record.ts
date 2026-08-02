// The "monitoring record" flavour of the AABB protocol, shared by the Korean washer/dryer/styler
// family (F24VDD, RH14_N_KR, Pd0F_F, S3BF_POD_DN4 - and, with different payload lengths, by the US
// models already supported here).
//
// The appliance reports its whole state as one fixed-length payload, wrapped in a record header:
//
//   0xEC  [dev][EC] [00][len][payload: previous state] [00][len][payload: current state]
//   0xEB  [dev][EB] [00][len][payload: current state]
//
// 0xEC is the regular report (~60s while running, ~1h while idle) and stacks the state it last
// reported in front of the current one - verified against the capture: record A is byte-identical to
// the preceding frame's record B on 351 of 353 consecutive pairs, the two exceptions being frames
// either side of a reconnect. 0xEB carries the current state alone and is what the appliance sends
// right after (re)connecting, before it has a previous state to stack.
//
// `buf` is the AABB body: AA+length and checksum+BB are already stripped by AABBDevice.

export function currentRecord(buf: Buffer, devByte: number, payloadLen: number): Buffer | undefined {
    if (buf.length < 4 || buf[0] !== devByte) return undefined

    // The record header is [00][len]; both are checked, so a model whose payload length changes
    // under a firmware update reports nothing rather than fields read off the wrong offsets.
    const recordLen = payloadLen + 2
    let start: number
    if (buf[1] === 0xec) {
        if (buf.length !== 2 + 2 * recordLen) return undefined
        start = 2 + recordLen
    } else if (buf[1] === 0xeb) {
        if (buf.length !== 2 + recordLen) return undefined
        start = 2
    } else {
        return undefined
    }

    if (buf[start] !== 0x00 || buf[start + 1] !== payloadLen) return undefined
    return buf.subarray(start + 2)
}
