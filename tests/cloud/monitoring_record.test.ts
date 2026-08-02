import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { currentRecord } from '@/cloud/devices/monitoring_record'

// The AABB body of frames this washer really sent: AA+length and checksum+BB stripped, as
// AABBDevice hands them to processAABB.
const OFF_RECORD = '0000000000000000000000000000000200000505411d010000000000000402022d1e'
const INITIAL_RECORD = '05002100210700020403020000000082400000000000000000000000000402022d1e'
const EC_BODY = Buffer.from('20ec' + '0022' + OFF_RECORD + '0022' + INITIAL_RECORD, 'hex')
const EB_BODY = Buffer.from('20eb' + '0022' + OFF_RECORD, 'hex')

describe('currentRecord', () => {
    test('an 0xEC frame yields the current state, not the previous one', () => {
        const rec = currentRecord(EC_BODY, 0x20, 34)
        assert.equal(rec?.length, 34)
        assert.equal(rec?.[0], 0x05) // state: Initial, and not the 0x00 (Off) of the stacked record
        assert.equal(rec?.[5], 0x07) // course
    })

    test('an 0xEB frame yields its single record', () => {
        const rec = currentRecord(EB_BODY, 0x20, 34)
        assert.equal(rec?.length, 34)
        assert.equal(rec?.[0], 0x00)
    })

    test('another appliance model on the same connection is not decoded', () => {
        assert.equal(currentRecord(EC_BODY, 0x30, 34), undefined)
    })

    test('a payload length that is not the one this model reports is rejected', () => {
        // the dryer's 25-byte record, read as if it were the washer's 34-byte one
        assert.equal(currentRecord(EC_BODY, 0x20, 25), undefined)
    })

    test('a record header that is not [00][len] is rejected', () => {
        const damaged = Buffer.from(EC_BODY)
        damaged[2 + 36] = 0x18 // the current record's leading 00
        assert.equal(currentRecord(damaged, 0x20, 34), undefined)
    })

    test('an 0xE2 frame yields its record, behind the 03 header the appliance uses there', () => {
        // the frame this dryer sent the instant it accepted a start command
        const body = Buffer.from('30e2' + '0319' + '020128012807000302000000000000895004f0010000007000', 'hex')
        const rec = currentRecord(body, 0x30, 25)
        assert.equal(rec?.length, 25)
        assert.equal(rec?.[0], 0x02) // running
        assert.equal(rec?.[5], 0x07) // the course the start command had just asked for
    })

    test('an 0xE2 frame with the 00 header of the other flavours is rejected', () => {
        const body = Buffer.from('30e2' + '0019' + '02'.repeat(25), 'hex')
        assert.equal(currentRecord(body, 0x30, 25), undefined)
    })

    test('frame types other than 0xEC/0xEB/0xE2 are left alone', () => {
        const heartbeat = Buffer.from('2072000000', 'hex')
        assert.equal(currentRecord(heartbeat, 0x20, 34), undefined)
    })

    test('a truncated frame does not read past its end', () => {
        assert.equal(currentRecord(Buffer.from('20ec', 'hex'), 0x20, 34), undefined)
    })
})
