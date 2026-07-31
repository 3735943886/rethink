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
 *   0x65  18-byte frame seen once, as the cooktop was switched off. Not decoded.
 *
 * The 48-byte record is one byte per entry of the model description's Monitoring.protocol list, in
 * that list's order - 48 entries for 48 bytes. That mapping is confirmed against a capture of a
 * ~6 minute cook: the bytes that moved were exactly one 9-byte burner group plus byte 0, the two
 * timers in that group decoded as (h, m, s) elapsed and (h, m, s) remaining summing to a constant
 * 1:00:00 auto-off, and the power level byte followed the panel from 9 to 3.
 *
 * NOTE ON BURNER NAMES: the names below are LG's own, from the model description. The capture was
 * made using the physically right-hand ring, and the group that moved is the one LG calls Left Rear
 * (cooktopState_1_1). So LG's naming does not appear to describe this Korean model's physical
 * layout, and Config.maxCooktopCount is 3 while five groups are described - two of these five never
 * carry anything. Which offset is which ring physically needs a capture per ring to settle.
 *
 * Read-only, and that may well be all this appliance allows. The model description does list a
 * control API - setCookStart selecting a burner, power level and timer, and setCookStop switching
 * the cooktop off - but the real cloud reports this device as controllableYn "N", its snapshot has
 * cooktopRemoteStart "DISABLE", and byte 0's remote-start bit was clear throughout the capture. A
 * cooktop that refuses to be lit from the network is the expected safety behaviour, not a fault.
 *
 * Nothing here was sent to the appliance either: every frame captured came from it, so the wire
 * encoding for a command is unknown, and packets that could light a burner are not something to
 * guess at. If the panel ever does grant remote start, one command issued from the LG app is enough
 * to learn the format - the bridge relays it, so it can be read off the management websocket.
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
// for as long as the burner has been on, the second counts the auto-off down.
const STATE = 0
const POWER_LEVEL = 1
const ELAPSED_SEC = 2
const ELAPSED_MIN = 3
const ELAPSED_HOUR = 4
const TIMER_DISPLAY = 5
const REMAINING_SEC = 6
const REMAINING_MIN = 7
const REMAINING_HOUR = 8

type Burner = { key: string; name: string; offset: number }

// Group offsets are the position of each burner's first field in the Monitoring.protocol list; the
// list runs WiFiAccess, FlexMode, then the five groups in this order.
const BURNERS: Burner[] = [
    { key: 'left_front', name: 'Left front', offset: 2 },
    { key: 'left_rear', name: 'Left rear', offset: 11 },
    { key: 'right_front', name: 'Right front', offset: 20 },
    { key: 'right_rear', name: 'Right rear', offset: 29 },
    { key: 'center', name: 'Center', offset: 38 },
]

// The model's enum for a burner state lists INIT, COOKING_IN_PROGRESS, PAUSED, LOCK in that order.
// Only 0 and 1 appear in the capture; 2 and 3 follow that ordering and are unconfirmed.
const STATE_NAMES: Record<number, string> = {
    0: 'Off',
    1: 'Cooking',
    2: 'Paused',
    3: 'Locked',
}

const STATE_COOKING = 1

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
        [`${b.key}_remaining_time`]: {
            platform: 'sensor',
            unique_id: `$deviceid-${b.key}_remaining_time`,
            state_topic: `$this/${b.key}_remaining_time`,
            name: `${b.name} remaining time`,
            icon: 'mdi:timer-outline',
            device_class: 'duration',
            unit_of_measurement: 'min',
        },
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
                    remote_start: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-remote_start',
                        state_topic: '$this/remote_start',
                        name: 'Remote start',
                        icon: 'mdi:remote',
                        entity_category: 'diagnostic',
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

    private processStatus(status: Buffer) {
        const wifiAccess = status[WIFI_ACCESS_OFFSET]
        this.publishProperty('remote_start', (wifiAccess & WIFI_ACCESS_REMOTE_START) !== 0 ? 'ON' : 'OFF')

        let anyCooking = false
        for (const b of BURNERS) {
            const g = status.subarray(b.offset, b.offset + 9)
            const state = g[STATE]
            if (state === STATE_COOKING) anyCooking = true

            this.publishProperty(`${b.key}_state`, STATE_NAMES[state] ?? 'unknown')
            this.publishProperty(`${b.key}_power_level`, g[POWER_LEVEL])
            this.publishProperty(`${b.key}_cook_time`, g[ELAPSED_HOUR] * 60 + g[ELAPSED_MIN])
            // Seconds are reported too (g[ELAPSED_SEC] / g[REMAINING_SEC]) but the appliance only
            // speaks up twice a minute, so a second-precision entity would be stale far more often
            // than it was right.
            this.publishProperty(
                `${b.key}_remaining_time`,
                g[TIMER_DISPLAY] !== 0 ? g[REMAINING_HOUR] * 60 + g[REMAINING_MIN] : 0,
            )
        }

        this.publishProperty('cooking', anyCooking ? 'ON' : 'OFF')
    }
}
