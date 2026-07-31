import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection, type ComponentInfo } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import AABBDevice from './aabb_device'

/**
 * LG electric range / cooktop (전기레인지), ThinQ model WBEY3GT, deviceType 303 ("Aries Hybrid2").
 *
 * The frames are AABB (buf below = the AABB body, AA+len and checksum+BB already stripped) and start
 * with 0x42, discriminated by buf[1]:
 *   0xEC  status - two stacked 48-byte records, the previous state followed by the current one.
 *         The appliance emits one whenever anything changes, and at least twice a minute while a
 *         burner runs (at :00 and :59 of the burner's own second counter).
 *   0xBF  81-byte frame, only its length byte reads 0x00 rather than the frame length. Carries a
 *         copy of the running burner's power level and a constant-looking tail. Not decoded.
 *   0x65  18-byte frame, emitted as the cooktop is switched off - seen on both of the two switch-offs
 *         captured. All zeroes bar a last byte that read 0x06 once and 0x04 the other time.
 *   0x00  4-byte acknowledgement of a command, 42 00 <the command's second byte> 00, sent within half
 *         a second of each one. Nothing waits on it, but it is how a command was confirmed to land.
 *   0x72  19-byte frame, 07 E4 0A (once 07 E5 0A) then zeroes. Every one of the three seen was
 *         followed within a second or two by a status frame whose remote-start bit had just flipped,
 *         and the two status frames that changed only the FOTA bit had no 0x72 before them - so it
 *         announces the remote-start permission and says nothing the status frame does not. Not
 *         decoded.
 *
 * The 48-byte record is one byte per entry of the model description's Monitoring.protocol list, in
 * that list's order - 48 entries for 48 bytes. That mapping is confirmed against a capture of a
 * ~6 minute cook: the bytes that moved were exactly one 9-byte burner group plus byte 0, the two
 * timers in that group decoded as (h, m, s) elapsed and (h, m, s) remaining summing to a constant
 * 1:00:00 auto-off, and the power level byte followed the panel from 9 to 3.
 *
 * The panel has a remote-control button, and pressing it sets byte 0's remote-start bit; switching
 * the cooktop off clears it again, so the permission only ever lives as long as the appliance is on.
 * A cooktop that will not be driven from the network unless someone standing at it says so is the
 * expected safety behaviour, not a fault, and every control here is published as unavailable until
 * that bit is set. (The cloud reports this device as controllableYn "N" and its snapshot has
 * cooktopRemoteStart "DISABLE" throughout - neither of those stops the LG app, or this, from
 * commanding it.)
 *
 * What can be commanded is what the LG app was seen to command, with the app's own frames read off
 * the bridge: switch a burner off, change a burner's timer, switch the whole cooktop off. The app
 * offers no way to light a ring on this model and never sent one, so neither does this - see
 * CMD_SET_BURNER below.
 */

const STATUS_FRAME_TYPE = 0xec
const STATUS_RECORD_LENGTH = 48
// 2B header (42 EC) + previous record + current record
const STATUS_FRAME_LENGTH = 2 + STATUS_RECORD_LENGTH * 2
const CURRENT_RECORD_OFFSET = 2 + STATUS_RECORD_LENGTH

// Byte 0, a bitmap the model calls WiFiAccess. Bit 0 enables firmware updates - not exposed, rethink
// drives updates itself - and bit 1 is the panel's "remote start" permission, without which the
// appliance refuses commands from the network. That one is worth seeing: it is why a remote command
// does nothing, and it is not otherwise visible from outside the appliance.
const WIFI_ACCESS_OFFSET = 0
const WIFI_ACCESS_REMOTE_START = 0x02

// Offsets inside one burner's 9-byte group. The two times are separate counters: the first counts up
// for as long as the burner has been on, the second counts the auto-off down. Both belong to this
// burner alone - light a second ring half an hour into the first one's hour and the two run their own
// counters side by side in the same frame, each from its own 1:00:00.
const STATE = 0
const POWER_LEVEL = 1
const ELAPSED_SEC = 2
const ELAPSED_MIN = 3
const ELAPSED_HOUR = 4
// Byte 5, the model's TimerDisp, is read but not published. It is a panel display hint, not a flag
// saying the countdown is valid: with two burners lit it was set on one and clear on the other while
// both counted down normally, so gating the remaining time on it would hide a running timer.
const REMAINING_SEC = 6
const REMAINING_MIN = 7
const REMAINING_HOUR = 8

type Burner = { key: string; name: string; offset: number; id?: number }

// Group offsets are the position of each burner's first field in the Monitoring.protocol list, which
// runs WiFiAccess, FlexMode, then five burner groups (LF, LR, RF, RR, Center), then DrawerPowerLevel.
//
// LG's names do not describe this Korean model. Config says cooktopCount "3RII" / maxCooktopCount 3,
// and ManualCook offers exactly three burners - LR, LF and RF - so only three of the five groups are
// real. Which is which was settled by lighting each ring on its own and watching which group moved:
//
//   physical ring        group that moved    LG's name for it
//   left rear   (좌상)    offset 20           RF
//   left front  (좌하)    offset  2           LF
//   right       (우)      offset 11           LR
//
// The names below are the physical ones. RR (offset 29) and Center (offset 38) are not published:
// Center never carries anything, and RR only ever echoes the lock state along with the real three.
//
// `id` is the burner selector a command carries. Each was read off a command the LG app sent and
// matched against the ring that actually went out; a burner with no id gets no controls, because
// commanding a burner we cannot name is how the wrong ring gets switched off. Unlike the group order,
// the ids do describe the layout - they count a six-place cooktop column by column, left rear 0, left
// front 1, a middle pair, then right rear 4 and right front 5, and this model's single right-hand
// ring answers to 5.
const BURNERS: Burner[] = [
    { key: 'left_rear', name: 'Left rear', offset: 20, id: 0x00 },
    { key: 'left_front', name: 'Left front', offset: 2, id: 0x01 },
    { key: 'right', name: 'Right', offset: 11, id: 0x05 },
]

// Commands, which are the F0 family rather than the 0x42 one the appliance reports in. Both were read
// off the LG app driving this cooktop with the panel's remote-control button pressed, and both were
// matched against the ring that actually went out:
//
//   F0 43 20 08 <burner> <level> <timer h> <timer m> 00 00 00 00   set one burner
//   F0 44 00                                                       switch the whole cooktop off
//
// The appliance acks each within half a second, 42 00 43 00 and 42 00 44 00 respectively.
//
// The app only ever sent a level of 0 (switch this ring off) or the level the ring was already at
// (leave it be, change its timer). It never lit a cold ring - the app offers no such button for this
// model - so nothing here sets a level, and a burner cannot be started from Home Assistant either.
const CMD_SET_BURNER = [0xf0, 0x43, 0x20, 0x08]
const CMD_COOKTOP_OFF = [0xf0, 0x44, 0x00]

// ControlTimerHour tops out at 11 and ControlTimerMin at 59.
const TIMER_MAX_MINUTES = 11 * 60 + 59

// The model's enum for a burner state lists INIT, COOKING_IN_PROGRESS, PAUSED, LOCK in that order.
// 0, 1 and 3 are confirmed against captures; PAUSED has never appeared.
const STATE_NAMES: Record<number, string> = {
    0: 'Off',
    1: 'Cooking',
    2: 'Paused',
    3: 'Locked',
}

const STATE_COOKING = 1
// The panel lock is not a burner state of its own - it overwrites one. Locking the panel mid-cook
// puts 3 in every burner's state byte, including burners that are off and the unused RR group, while
// the power level and both timers of the burner that is alight carry on exactly as before. So the
// state byte alone cannot say whether a ring is hot, and the elapsed counter is what settles it.
const STATE_LOCKED = 3

// Everything that sends a command carries this on top of the device-wide availability, so Home
// Assistant greys the control out unless the panel is currently granting remote start - which is the
// only time the appliance would act on it anyway.
const REMOTE_START_REQUIRED = {
    availability: [
        { topic: '$this/availability' },
        { topic: '$rethink/availability' },
        { topic: '$this/remote_start', payload_available: 'ON', payload_not_available: 'OFF' },
    ],
    availability_mode: 'all',
}

function burnerComponents(b: Burner): Record<string, ComponentInfo> {
    return allowExtendedType({
        [`${b.key}_state`]: {
            platform: 'sensor',
            unique_id: `$deviceid-${b.key}_state`,
            state_topic: `$this/${b.key}_state`,
            name: `${b.name} state`,
            icon: 'mdi:circle-slice-8',
            // free-text (NOT device_class:enum): an unmapped state code falls back to 'unknown'.
        },
        [`${b.key}_power_level`]: {
            platform: 'sensor',
            unique_id: `$deviceid-${b.key}_power_level`,
            state_topic: `$this/${b.key}_power_level`,
            name: `${b.name} power level`,
            icon: 'mdi:fire',
            state_class: 'measurement',
            // 0 is off and the panel's dial runs 1-9, but the model allows up to 11, which is
            // presumably the boost step above 9. Published as the raw number either way.
        },
        [`${b.key}_cook_time`]: {
            platform: 'sensor',
            unique_id: `$deviceid-${b.key}_cook_time`,
            state_topic: `$this/${b.key}_cook_time`,
            name: `${b.name} cooking time`,
            icon: 'mdi:timer-play-outline',
            device_class: 'duration',
            unit_of_measurement: 'min',
        },
        // Settable, so a number rather than a sensor - but only while the burner is alight, because
        // the command that sets a timer has to restate the burner's power level and a level of 0 is
        // the command to switch it off.
        [`${b.key}_remaining_time`]: {
            platform: 'number',
            unique_id: `$deviceid-${b.key}_remaining_time`,
            state_topic: `$this/${b.key}_remaining_time`,
            ...(b.id !== undefined
                ? { command_topic: `$this/${b.key}_remaining_time/set`, ...REMOTE_START_REQUIRED }
                : {}),
            name: `${b.name} remaining time`,
            icon: 'mdi:timer-outline',
            device_class: 'duration',
            unit_of_measurement: 'min',
            min: 0,
            max: TIMER_MAX_MINUTES,
            step: 1,
            mode: 'box',
        },
        ...(b.id === undefined
            ? {}
            : {
                  [`${b.key}_off`]: {
                      platform: 'button',
                      unique_id: `$deviceid-${b.key}_off`,
                      command_topic: `$this/${b.key}_off/set`,
                      name: `${b.name} off`,
                      icon: 'mdi:fire-off',
                      ...REMOTE_START_REQUIRED,
                  },
              }),
    })
}

export default class Device extends AABBDevice {
    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq)
        this.setConfig(
            allowExtendedType({
                ...HADevice.config(meta, { name: 'LG Cooktop' }),
                components: {
                    cooking: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-cooking',
                        state_topic: '$this/cooking',
                        name: 'Cooking',
                        icon: 'mdi:stove',
                        device_class: 'heat',
                    },
                    locked: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-locked',
                        state_topic: '$this/locked',
                        name: 'Panel lock',
                        icon: 'mdi:lock',
                        // No device_class: HA's 'lock' class reads ON as *unlocked*, and this is ON
                        // when the panel is locked.
                    },
                    remote_start: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-remote_start',
                        state_topic: '$this/remote_start',
                        name: 'Remote start',
                        icon: 'mdi:remote',
                        entity_category: 'diagnostic',
                    },
                    power_off: {
                        platform: 'button',
                        unique_id: '$deviceid-power_off',
                        command_topic: '$this/power_off/set',
                        name: 'Switch off',
                        icon: 'mdi:stove',
                        ...REMOTE_START_REQUIRED,
                    },
                    ...Object.assign({}, ...BURNERS.map(burnerComponents)),
                },
            }),
        )
    }

    processAABB(buf: Buffer) {
        if (buf.length !== STATUS_FRAME_LENGTH) return
        if (buf[0] !== 0x42 || buf[1] !== STATUS_FRAME_TYPE) return

        // The frame restates the previous record so a listener that missed one can still see what
        // changed. We only ever want where the appliance is now.
        this.processStatus(buf.subarray(CURRENT_RECORD_OFFSET))
    }

    // A command has to restate the burner's power level, and refusing to command a burner that is not
    // alight needs to know whether it is - both come from the last status the appliance sent.
    private levels: Record<string, number> = {}
    private remoteStart = false

    setProperty(prop: string, mqttValue: string) {
        // Home Assistant already hides these unless the panel has granted remote start; this is for
        // anything else that reaches the topic. The appliance would refuse the command anyway.
        if (!this.remoteStart) return

        if (prop === 'power_off') return this.send(Buffer.from(CMD_COOKTOP_OFF))

        for (const b of BURNERS) {
            if (b.id === undefined) continue

            if (prop === `${b.key}_off`) return this.sendBurner(b.id, 0, 0)

            if (prop === `${b.key}_remaining_time`) {
                const level = this.levels[b.key] ?? 0
                // Setting a timer on a ring that is not lit would mean sending level 0, which is the
                // command to switch it off. There is nothing to time, so do nothing.
                if (level === 0) return

                const minutes = Math.max(0, Math.min(TIMER_MAX_MINUTES, Math.round(Number(mqttValue))))
                if (!Number.isFinite(minutes)) return
                return this.sendBurner(b.id, level, minutes)
            }
        }
    }

    private sendBurner(id: number, level: number, minutes: number) {
        this.send(Buffer.from([...CMD_SET_BURNER, id, level, Math.floor(minutes / 60), minutes % 60, 0, 0, 0, 0]))
    }

    private processStatus(status: Buffer) {
        const wifiAccess = status[WIFI_ACCESS_OFFSET]
        this.remoteStart = (wifiAccess & WIFI_ACCESS_REMOTE_START) !== 0
        this.publishProperty('remote_start', this.remoteStart ? 'ON' : 'OFF')

        let anyCooking = false
        let locked = false
        for (const b of BURNERS) {
            const g = status.subarray(b.offset, b.offset + 9)
            const state = g[STATE]
            // The burner has been alight for as long as its elapsed counter has been running. It
            // reads zero for the few seconds between the ring being lit and the first tick, which is
            // why the state byte is the primary test and the counter only stands in for it under the
            // lock.
            const elapsed = g[ELAPSED_HOUR] * 3600 + g[ELAPSED_MIN] * 60 + g[ELAPSED_SEC]
            const cooking = state === STATE_COOKING || (state === STATE_LOCKED && elapsed > 0)
            if (cooking) anyCooking = true
            if (state === STATE_LOCKED) locked = true

            // Under the lock the state byte says nothing about this burner, so report what the rest
            // of the group shows and leave the lock itself to its own entity.
            this.publishProperty(
                `${b.key}_state`,
                state === STATE_LOCKED ? (cooking ? 'Cooking' : 'Off') : (STATE_NAMES[state] ?? 'unknown'),
            )
            this.levels[b.key] = g[POWER_LEVEL]
            this.publishProperty(`${b.key}_power_level`, g[POWER_LEVEL])
            this.publishProperty(`${b.key}_cook_time`, g[ELAPSED_HOUR] * 60 + g[ELAPSED_MIN])
            // Seconds are reported too (g[ELAPSED_SEC] / g[REMAINING_SEC]) but the appliance only
            // speaks up twice a minute, so a second-precision entity would be stale far more often
            // than it was right.
            this.publishProperty(`${b.key}_remaining_time`, g[REMAINING_HOUR] * 60 + g[REMAINING_MIN])
        }

        this.publishProperty('cooking', anyCooking ? 'ON' : 'OFF')
        this.publishProperty('locked', locked ? 'ON' : 'OFF')
    }
}
