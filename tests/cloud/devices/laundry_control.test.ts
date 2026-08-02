import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
    CONTROL_PAUSE,
    CONTROL_POWER_OFF,
    CourseSelection,
    codeOf,
    courseControl,
    shortControl,
} from '@/cloud/devices/monitoring_command'
import { startPayload as washerStart } from '@/cloud/devices/F24VDD'
import { startPayload as dryerStart } from '@/cloud/devices/RH14_N_KR'
import { startPayload as miniStart } from '@/cloud/devices/Pd0F_F'
import { startPayload as stylerStart, resumePayload as stylerResume } from '@/cloud/devices/S3BF_POD_DN4'

/*
 * The frames the ThinQ app sent these four appliances, recorded off the wire. Everything below asks
 * one question: does the handler build the same bytes the app did? The per-course settings come from
 * the model JSON, so a table that drifts - a course code, an operating course, a mask on the wrong
 * byte - shows up here as a mismatch against traffic that really happened.
 *
 * AA/length and checksum/BB are stripped, and so is the f0 26 that courseControl() adds back.
 */
const app = (body: string) => Buffer.from(body, 'hex')

describe('short controls', () => {
    test('power off and pause are the same frame on every appliance of the family', () => {
        assert.equal(shortControl(CONTROL_POWER_OFF).toString('hex'), 'f024010100')
        assert.equal(shortControl(CONTROL_PAUSE).toString('hex'), 'f024040100')
    })
})

describe('F24VDD start', () => {
    test('Colour Care, as the app sent it', () => {
        assert.deepEqual(washerStart(10, false), app('0a0202020300002000201000000000000000000000'))
    })

    test('Heavy Duty, as the app sent it', () => {
        assert.deepEqual(washerStart(6, false), app('060303040300002000200e00000000000000000000'))
    })

    test('Steam Refresh sets the steam bit, and the app agreed', () => {
        // the course fixes steam on: the flags byte carries 0x10 beside the remote-start 0x20
        assert.deepEqual(washerStart(1, false), app('010200000000003000200100000000000000000000'))
    })

    test('resuming clears the initial bit and changes nothing else', () => {
        const start = washerStart(6, false)!
        const resume = washerStart(6, true)!
        assert.equal(resume[9], 0)
        assert.equal(start[9], 0x20)
        assert.deepEqual(resume.subarray(0, 9), start.subarray(0, 9))
        assert.deepEqual(resume.subarray(10), start.subarray(10))
    })

    test('a course with no preset - the downloaded-course dial position - is not started', () => {
        assert.equal(washerStart(14, false), undefined)
        assert.equal(washerStart(0, false), undefined)
    })
})

describe('RH14_N_KR start', () => {
    test('Cotton Normal, as the app sent it', () => {
        assert.deepEqual(dryerStart(7, false), app('0703020000000000000003000000'))
    })

    test('the settings are the course defaults the dryer reported back', () => {
        // Iron Dry on Eco Hybrid Normal, which is what the record said a second after this frame
        const payload = dryerStart(7, false)!
        assert.equal(payload[1], 3)
        assert.equal(payload[2], 2)
    })

    test('resuming clears the initial bit, keeping remote start', () => {
        assert.equal(dryerStart(7, true)![10], 0x01)
    })

    test('a course this dial does not have is not started', () => {
        assert.equal(dryerStart(1, false), undefined)
    })
})

describe('Pd0F_F start', () => {
    test('Small Load, as the app sent it', () => {
        assert.deepEqual(miniStart(1, false), app('010001000200000000000000000005'))
    })

    test('resume, as the app sent it', () => {
        assert.deepEqual(miniStart(1, true), app('010001000200000000000000000004'))
    })

    test('a course this drawer does not have is not started', () => {
        assert.equal(miniStart(10, false), undefined)
    })
})

describe('S3BF_POD_DN4 start', () => {
    // The whole 46-byte recipe, not just a course code - the frame that really made this cabinet run.
    const FINE_DUST = '1e010004000000000082000000000000000000000005c80000000000000000000003000002c80001c80028c80000'

    test('Fine Dust, as the app sent it', () => {
        assert.deepEqual(stylerStart(30), app(FINE_DUST))
    })

    test('every startable course fills the frame and marks the first duration', () => {
        for (const course of [1, 3, 5, 6, 7, 8, 11, 12, 15, 22, 28, 30, 31, 32, 33, 34]) {
            const payload = stylerStart(course)
            assert.equal(payload?.length, 46, `course ${course}`)
            assert.equal(payload?.[0], course)
            assert.equal(payload?.[3], 0x04) // initial bit: this is a start, not a resume
            assert.equal(payload![9] & 0x80, 0x80)
        }
    })

    test('resume is the shorter frame, empty apart from the course', () => {
        const payload = stylerResume(30)
        assert.equal(payload.length, 45)
        assert.equal(payload[0], 30)
        assert.ok(payload.subarray(1).every((b) => b === 0))
    })

    test('a course the app will not start remotely either is not started', () => {
        assert.equal(stylerStart(23), undefined) // Indoor Dry 120 min
    })
})

describe('the frame around a payload', () => {
    test('courseControl prefixes the command byte', () => {
        assert.equal(courseControl(Buffer.from([1, 2])).toString('hex'), 'f0260102')
    })
})

describe('CourseSelection', () => {
    const COURSES: Record<number, string> = { 0: 'None', 6: 'Heavy Duty', 7: 'Cotton' }

    test('follows the appliance until Home Assistant picks something', () => {
        const selection = new CourseSelection()
        selection.follow(7)
        assert.equal(selection.selected, 7)

        selection.select(6)
        selection.follow(7) // the next status report repeats the dial - and must not undo the choice
        selection.follow(7)
        assert.equal(selection.selected, 6)
    })

    test('the dial moving wins again', () => {
        const selection = new CourseSelection()
        selection.follow(7)
        selection.select(6)
        selection.follow(0) // powered off: not a course, and not a reason to forget one
        assert.equal(selection.selected, 6)
        selection.follow(7) // someone turned the dial back
        assert.equal(selection.selected, 7)
    })

    test('names round-trip through the table the states are published with', () => {
        assert.equal(codeOf(COURSES, 'Heavy Duty'), 6)
        assert.equal(codeOf(COURSES, 'Nonexistent'), undefined)
    })
})
