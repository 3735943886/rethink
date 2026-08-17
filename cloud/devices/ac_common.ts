import TLVDevice, { FieldDefinition } from './tlv_device'
import { Device as Thinq2Device } from '../thinq2/device'
import { ClimateComponent, DeviceDiscovery, type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import * as TLV from '@/util/tlv'
import crc16 from '@/util/crc16'
import { racAirTemp, racPipeTemp } from '@/util/ac_tables'
import log from '@/util/logging'
import HADevice from './base'
import type { ReservationDeadlines, ReservationStore } from '@/bridge/reservation-store'

type PowerModeChangeHook = () => void
type CheckMode = (arg: number) => boolean

/*
 * The tags this class handles by name. Tags that appear once, next to the label of the entity
 * they feed, are left as literals there - the surrounding call already says what they are.
 */
const TAG_POWER = 0x1f7
const TAG_MODE = 0x1f9
const TAG_FAN = 0x1fa
const TAG_TEMP_CURRENT = 0x1fd
const TAG_TEMP_TARGET = 0x1fe
const TAG_AUTO_DRY = 0x20e
const TAG_AUTO_DRY_REMAIN = 0x225
const TAG_POWER_W = 0x2b3
const TAG_FILTER_REMAINING = 0x355
const TAG_FILTER_LIFE = 0x356
/* The two tags an IDU may use to report whether it is actually running */
const TAG_IDU_THERMO_ON_OFF = 0x189
const TAG_IDU_RUNNING_ALT = 0x6c
/* Capability tags */
const TAG_CAPS_MODES = 0x2c1
const TAG_CAPS_FANS = 0x2c2
const TAG_CAPS_FEATURE = 0x2cc
const TAG_CAPS_JET_SWING = 0x2cd
const TAG_CAPS_TIMER = 0x2d3
const TAG_CAPS_EEPROM_CRC = 0x2da
const TAG_CAPS_TEMP_MIN = 0x2e1
const TAG_CAPS_TEMP_MAX = 0x2e2

/* Bits of the feature bitmap, 0x2cc unless the model says otherwise */
const CAP_AIR_PURIFY = 0x01
const CAP_ENERGY_SAVE = 0x02
const CAP_AUTO_DRY = 0x04

/*
 * Bits of the jet / positional-swing bitmap, 0x2cd. The model description names this one
 * support.racSubMode and labels each bit, writing bit N as key N+1:
 *
 *   key 1, 2   @AC_MAIN_WIND_MODE_JET_W                    jet cool, jet heat
 *   key 3, 5   @AC_MAIN_WIND_DIRECTION_SWING_UP_DOWN_W     vertical swing, either bit
 *   key 6      @AC_MAIN_WIND_DIRECTION_SWING_LEFT_RIGHT_W  horizontal swing
 *
 * Reading the enum is how bit 4 got here: no unit on hand sets it, so no capture could have shown
 * that it is the vertical axis too, and a unit advertising that way was being denied the entity.
 *
 * An axis therefore accepts every bit any model labels with it, and horizontal keeps bit 3 even
 * though the enum above does not define key 4. These tables are per-model and do not share a key
 * space - the PAC stand unit has no support.racSubMode at all, and its support.reserve numbers the
 * sleep timer 8 where the CST numbers it 1 - so a key missing from one model's table says nothing
 * about the others, while a RAC wall unit on file does set bit 3. Widening an axis can only add it
 * to a unit that advertises it; narrowing one takes it away from a unit that already works.
 */
const CAP_JET_COOL = 0x01
const CAP_JET_HEAT = 0x02
const CAP_SWING_VERTICAL = 0x04 | 0x10
const CAP_SWING_HORIZONTAL = 0x08 | 0x20

/*
 * Bit of the timer bitmap, 0x2d3 = support.reserve, same key-is-bit-plus-one convention.
 *
 * The bitmap also describes a turn-on / turn-off pair on 0x21c / 0x21b (bit 4, @TIMEBS_ONOFF), and
 * these units do set that bit. They are not exposed: a schedule that lives in the appliance is one
 * Home Assistant cannot see the effect of until it fires, and anyone automating a switch-on already
 * has a better way to do it. The sleep timer stays because it is a live countdown the unit acts on
 * by itself, which is worth reporting.
 *
 * A model that runs the pair here instead of on the appliance is a different case and says so with
 * relayReservation: there the two entities are this driver's own countdown, not a schedule hidden
 * inside the unit, so Home Assistant can see what they are doing.
 */
const CAP_SLEEP_TIMER = 0x01

/*
 * The tags the cloud decodes its airState.reservation.* bundle from. Each mapping was
 * established by feeding a distinct value upstream and reading back which key the cloud
 * produced, so they are measurements rather than guesses:
 *
 *   0x21b -> targetTimeToStop      0x21c -> targetTimeToStart   (both in minutes)
 *   0x145 -> relativeStartTime     0x146 -> relativeStopTime
 *   0x17c -> banDisturbSleep       0x1de -> Cancel
 *   0x3b5 -> stopHeatingTimer
 *
 * The LG app reads and writes the whole bundle at once, so a key it cannot resolve fails the
 * call outright ("제품과의 연결 상태가 좋지 않아요"). See relayReservation.
 */
const TAG_RES_STOP = 0x21b
const TAG_RES_START = 0x21c
const TAG_RES_RELATIVE_START = 0x145
const TAG_RES_RELATIVE_STOP = 0x146
const TAG_RES_BAN_DISTURB_SLEEP = 0x17c
const TAG_RES_CANCEL = 0x1de
const TAG_RES_STOP_HEATING = 0x3b5

/*
 * Test a capability bit. A unit that does not report the bitmap at all reads as having none of
 * its features, which is the useful answer: the entities behind it would have nothing to show.
 */
function capBit(bitmap: number | undefined, mask: number) {
    return bitmap != null && !!(bitmap & mask)
}

/*
 * A mapping between HA labels and wire values, given as [label, wire] pairs. The option list HA is
 * offered and both transform directions are derived from the same list, in the order written, so
 * they cannot drift out of sync.
 *
 * A label may appear more than once. That is how a unit says "these wire values all mean this to
 * the user": the label is offered to HA once, every one of its wire values reads back as it, and
 * the FIRST is what a write sends. The stand units need it - they report fan speed 8 while drying
 * and 7 while jet runs, both meaning "the appliance is driving the fan itself", and a reading that
 * dropped one of them would leave HA showing the speed picked before jet was switched on.
 */
export type WireLevels = ReadonlyArray<readonly [string, number]>

function wireMaps(levels: WireLevels) {
    const toWire = new Map<string, number>()
    const labels: string[] = []
    for (const [label, wire] of levels) {
        if (toWire.has(label)) continue // an alias: readable, but not what a write sends
        toWire.set(label, wire)
        labels.push(label)
    }

    return {
        labels,
        toLabel: new Map(levels.map(([label, wire]) => [wire, label])),
        toWire,
    }
}

/*
 * Positional swing, 0x321 / 0x322: a numbered vane position, 100 for continuous sweep, 0 for
 * parked. The horizontal vane also has two paired positions.
 */
const SWING_VERTICAL_POSITIONS: WireLevels = [
    ['1', 1],
    ['2', 2],
    ['3', 3],
    ['4', 4],
    ['5', 5],
    ['6', 6],
    ['on', 100],
    ['off', 0],
]

const SWING_HORIZONTAL_POSITIONS: WireLevels = [
    ['1', 1],
    ['2', 2],
    ['3', 3],
    ['4', 4],
    ['5', 5],
    ['1-3', 13],
    ['3-5', 35],
    ['on', 100],
    ['off', 0],
]

/* Plain on/off swing, 0x205 / 0x206 */
export const SWING_ON_OFF: WireLevels = [
    ['on', 1],
    ['off', 0],
]

/* A single vane driven on/off, but on a positional tag, where continuous sweep is 100 */
export const SWING_SWEEP_ON_OFF: WireLevels = [
    ['on', 100],
    ['off', 0],
]

/*
 * A single swing axis: which tag drives it, which of HA's two swing attributes it is published
 * as, and the values it takes. A unit with one swing only should use 'swing_mode' - HA renders
 * swing_horizontal_mode as the secondary control.
 */
export type SwingAxis = {
    tag: number
    name: 'swing_mode' | 'swing_horizontal_mode'
    levels: WireLevels
    /* tags to re-send alongside the swing write, for units that want the context */
    attach?: number[]
}

/* The on/off variant, on its own pair of tags rather than the positional ones */
export const SWING_AXES_ON_OFF: SwingAxis[] = [
    { tag: 0x205, name: 'swing_mode', levels: SWING_ON_OFF },
    { tag: 0x206, name: 'swing_horizontal_mode', levels: SWING_ON_OFF },
]

/* The discovery config once the climate component is known to be in it */
type ClimateConfig = DeviceDiscovery & { components: { climate: ClimateComponent } }

/* The transforms of a plain on/off tag driving an HA switch */
const SWITCH_XFORM = {
    write_xform: (val: string) => (val === 'ON' ? 1 : 0),
    read_xform: (raw: number) => (raw ? 'ON' : 'OFF'),
} satisfies Pick<FieldDefinition, 'read_xform' | 'write_xform'>

/*
 * How a switch is wired when a plain 0/1 is not what the tag takes. Several are not: an AI dry
 * enable is 0 / 255, a display-light or beep tag stores 1 for "off", and a cleaning cycle can be
 * started with one value and report a different one back while it runs.
 */
export type SwitchOptions = {
    /* wire value written for ON, and read back as ON unless readOnValue says otherwise (default 1) */
    onValue?: number
    /* wire value written for OFF (default 0) */
    offValue?: number
    /* wire value that reads back as ON, when the appliance reports something else than it accepts */
    readOnValue?: number
    /* HA entity_category; 'config' unless given, and an explicit undefined means Controls */
    entityCategory?: string
}

function switchXform(options: SwitchOptions) {
    const on = options.onValue ?? 1
    const off = options.offValue ?? 0
    const readOn = options.readOnValue ?? on

    return {
        write_xform: (val: string) => (val === 'ON' ? on : off),
        /*
         * An exact comparison, not truthiness: with onValue 0 (an inverted tag) or a distinct
         * readOnValue, "non-zero" is the wrong question.
         */
        read_xform: (raw: number) => (raw === readOn || raw === on ? 'ON' : 'OFF'),
    } satisfies Pick<FieldDefinition, 'read_xform' | 'write_xform'>
}

/*
 * Shared implementation for LG air conditioners speaking the DualCool TLV scheme: standard tags
 * 0x1f7 power, 0x1f9 operation mode, 0x1fa fan speed, 0x1fd current temperature, 0x1fe target
 * temperature, the 0x2cc / 0x2cd / 0x2d3 capability bitmaps, the diagnostic pipe/ODU temperatures
 * and the basic-filter priv-command.
 *
 * What is here is the protocol, not any one unit's behaviour: nothing below is tuned to a
 * particular model, and where units are known to differ the difference is stated by the subclass
 * as an override rather than translated into some other model's wire format. The corrections the
 * residential units need (their setpoint range, their power reading bias, their filter counter)
 * live in RAC_056905_WW, not here.
 *
 *   modeLevels                          0x1f9 wire values are not the same everywhere - e.g. auto
 *                                       is wire 6 on DualCool wall units but wire 3 on the ceiling
 *                                       cassettes, which have no heat at all
 *   fanLevels                           the 0x1fa scale and the number of steps differ
 *   featureCaps / jetSwingCaps / timerCaps    which tag carries a given capability bitmap
 *   hasAirPurify / hasEnergySave / hasAutoDry / hasJetCool / hasJetHeat / hasSwing*
 *                                       the semantic capabilities, derived from the bitmaps above
 *   swingAxes                           which tag drives which vane, and over what values
 *   autoDryStyle / filterStyle          which implementation of a feature this class owns the
 *                                       unit has - one question, one answer
 *   temperatureRange / powerReadXform / hasPowerSensor
 *                                       what the unit reports and how it has to be corrected
 *   powerOnWithModeWrite                whether a mode write must carry 0x1f7=1 to power the unit on
 *   addModelFields                      entities that no other model has been seen to report
 */
export default abstract class ACDevice extends TLVDevice {
    meta: Metadata
    initialValuesReceived: boolean = false
    powerChangeHooks: PowerModeChangeHook[] = []
    powerStatePrev?: boolean
    modeChangeHooks: PowerModeChangeHook[] = []
    modePrev?: string
    /* Symmetric with the two above, for anything derived from the fan speed. */
    fanChangeHooks: PowerModeChangeHook[] = []
    fanPrev?: string | number
    airClean: boolean = false
    jetMode: boolean = false
    energySave: boolean = false
    tlvBlacklistDisableTimer: ReturnType<typeof setTimeout> | undefined
    increasedQueryIntervalTimeout: ReturnType<typeof setTimeout> | undefined
    filterUsedTime: number = 0
    filterLifeTime: number = 0
    filterChangedDate: number = 0
    filterInitialQueryTimeout: ReturnType<typeof setTimeout> | undefined
    filterQueryTimer: ReturnType<typeof setInterval> | undefined
    /* A reset waiting for the query that reads the counter one last time; see the reset button. */
    filterDoReset: boolean = false
    /* --- reservation relay state; see relayReservation --- */
    resDeadline: ReservationDeadlines = {}
    resTimer: ReturnType<typeof setInterval> | undefined
    resSeq: number = 0
    resCloudWriteHook: ((buf: Buffer) => void) | undefined
    resStore: ReservationStore | undefined

    /* --- per-model description of the protocol; see the class comment --- */

    /* HA device name */
    readonly haDeviceName: string = 'LG Air Conditioner'

    /*
     * The 0x1f9 operation modes and the 0x1fa fan speeds this unit has, as the same [label, wire]
     * lists the swing axes and the selects use. Written in the order HA should offer them: the
     * option list, the wire -> label read and the label -> wire write all come from the one list.
     */
    abstract readonly modeLevels: WireLevels
    abstract readonly fanLevels: WireLevels

    /*
     * Built on first use rather than in a field initialiser: a base-class field is initialised
     * during super(), before the subclass has assigned the list it would be built from. Both are
     * discarded when capabilities arrive, because that is what narrows them - see capsFiltered().
     */
    private modeMapsCache?: ReturnType<typeof wireMaps>
    private fanMapsCache?: ReturnType<typeof wireMaps>

    get modeMaps() {
        return (this.modeMapsCache ??= wireMaps(this.capsFiltered(this.modeLevels, this.modeCaps(), 'mode')))
    }

    get fanMaps() {
        return (this.fanMapsCache ??= wireMaps(this.capsFiltered(this.fanLevels, this.fanCaps(), 'fan speed')))
    }

    capabilityReceived() {
        /* the lists above are narrowed by these, so anything built from them is now stale */
        this.modeMapsCache = undefined
        this.fanMapsCache = undefined
    }

    /*
     * Which operation modes and fan speeds the unit says it has. Both are bitmaps indexed by the
     * wire value - bit N set means wire value N is available - and the model description names the
     * bits as support.airState.opMode and support.airState.windStrength, where bit N is written as
     * key N+1.
     *
     * A model whose bitmap does not describe its list overrides these to return undefined.
     */
    modeCaps(): number | undefined {
        return this.raw_clip_state[TAG_CAPS_MODES]
    }

    fanCaps(): number | undefined {
        return this.raw_clip_state[TAG_CAPS_FANS]
    }

    /*
     * Narrow a per-model list to what the unit advertises. The list is the vocabulary - which wire
     * value carries which name, which only the model knows - and the bitmap is this particular
     * unit's answer about which of them it has. One modelId covers units that differ: the wall
     * units' list declares heat and auto, and a unit that has neither answers 7, i.e. cool, dry and
     * fan only, so without this HA offers two modes that are silently ignored when selected.
     *
     * Left alone when the bitmap is absent, zero, or describes none of the declared levels: the
     * bitmaps carry bits well above the level cluster whose meaning is not established, so a
     * bitmap this does not recognise is a reason to publish the model's list unchanged rather than
     * to publish nothing.
     */
    capsFiltered(levels: WireLevels, bitmap: number | undefined, what: string): WireLevels {
        if (!bitmap) return levels

        const kept = levels.filter(([, wire]) => wire < 31 && (bitmap & (1 << wire)) !== 0)
        if (kept.length === 0) return levels

        const dropped = levels.filter((l) => !kept.includes(l))
        if (dropped.length)
            log('status', this.id, `${what}: the unit does not advertise ${dropped.map(([label]) => label).join(', ')}`)
        return kept
    }

    /* hvac modes advertised to HA. 'off' is not a wire value - it is the power tag being 0. */
    get haModes(): string[] {
        return ['off', ...this.modeMaps.labels]
    }

    get haFanModes(): string[] {
        return this.fanMaps.labels
    }

    /*
     * Whether selecting a mode while the unit is off has to turn it on. Units that ignore a
     * standalone mode write need 0x1f7=1 sent along with it.
     */
    readonly powerOnWithModeWrite: boolean = false

    /*
     * Setpoint resolution in degC. 0x1fe is always in half-degrees on the wire; this is only what
     * HA is told it may ask for. Units whose panel steps in whole degrees say 1.
     * TODO: no capability bit for this has been identified yet
     */
    readonly tempStep: number = 0.5

    /*
     * The mode-dependent switches (air purify, energy saving) are reported only while the unit
     * runs in the matching mode. On models where that makes the read-back unreliable, marking them
     * optimistic gets HA to show two assumed-state buttons rather than a switch that snaps back.
     */
    readonly modeDependentSwitchOptimistic: boolean = false

    /*
     * Run the LG app's on/off reservation here instead of on the appliance.
     *
     * Two measured facts make this necessary on units of this family. The unit accepts a write to
     * the two timer tags and acknowledges it, but never acts on it - a two-minute turn-on timer
     * written straight to 0x21c never fired - and it never reports those tags back. Because the
     * cloud builds its airState.reservation.* bundle from what the appliance reports, and the
     * bridge's re-registration wipes the stored snapshot, those keys disappear for good and the
     * app's reservation screen fails with "제품과의 연결 상태가 좋지 않아요".
     *
     * With this on, the driver reports the bundle upstream itself, picks up the timer the cloud
     * writes, counts it down against the local clock and switches the unit at zero. Sleep timer
     * (0x21a) is untouched: the appliance reports and runs that one on its own.
     */
    readonly relayReservation: boolean = false

    /*
     * Upper bound of the 취침예약 entities, in minutes. 15 h is what the wall-mounted units take;
     * a model whose spec (or panel) says otherwise overrides it.
     */
    readonly sleepTimerMaxMinutes: number = 15 * 60

    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq)
        this.meta = meta
    }

    setReservationStore(store: ReservationStore) {
        this.resStore = store
    }

    start() {
        super.start()

        /* Subclass fields are only assigned once our constructor has returned, so the flag can
         * not be read there. */
        if (!this.relayReservation || this.resCloudWriteHook) return

        this.resDeadline = this.resStore?.load(this.id) ?? {}
        this.resCloudWriteHook = (buf: Buffer) => this.observeCloudWrite(buf)
        this.thinq.on('sendData', this.resCloudWriteHook)

        /* Turning the unit off by hand satisfies a pending off-reservation, and vice versa. */
        this.powerChangeHooks.push(() => {
            /*
             * The hooks run before powerStatePrev is updated, so the state being entered is the
             * one being reported now - and the very first report is a baseline rather than a
             * transition, so nothing has been satisfied by it.
             */
            if (this.powerStatePrev == null) return
            const satisfied = this.powerStatePrev ? 'stop' : 'start'
            if (this.resDeadline[satisfied] != null) {
                this.resDeadline[satisfied] = undefined
                this.persistReservation()
                this.publishReservation()
            }
        })

        this.publishReservation()
        this.resTimer = setInterval(() => this.reservationTick(), 60 * 1000)
    }

    cancelPendingWork() {
        /* clearTimeout / clearInterval ignore undefined, so no guard is needed */
        clearTimeout(this.tlvBlacklistDisableTimer)
        this.tlvBlacklistDisableTimer = undefined
        clearTimeout(this.increasedQueryIntervalTimeout)
        this.increasedQueryIntervalTimeout = undefined
        clearTimeout(this.filterInitialQueryTimeout)
        this.filterInitialQueryTimeout = undefined
        clearInterval(this.filterQueryTimer)
        this.filterQueryTimer = undefined
        clearInterval(this.resTimer)
        this.resTimer = undefined
        if (this.resCloudWriteHook) {
            this.thinq.removeListener('sendData', this.resCloudWriteHook)
            this.resCloudWriteHook = undefined
        }

        super.cancelPendingWork()
    }

    /*
     * A reservation arrives as an ordinary TLV write of the timer tags, on the same channel as
     * every other control, so it is picked up from what goes out to the appliance. HA writes to
     * the two timer entities travel the same path and are picked up here too.
     */
    observeCloudWrite(buf: Buffer) {
        if (buf.length < 13) return
        if (buf[2] !== 0x04 || buf[3] !== 0x00 || buf[4] !== 0x00 || buf[5] !== 0x00) return
        if (buf[6] !== 0x65 || buf[7] !== 0x02 || buf[8] !== 0x01) return

        const length = buf[10]
        if (11 + length > buf.length) return

        for (const { t, v } of TLV.parse(buf.subarray(11, 11 + length))) {
            if (t === TAG_RES_START) this.setReservation('start', v)
            else if (t === TAG_RES_STOP) this.setReservation('stop', v)
        }
    }

    /* `minutes` counts from now; 0 cancels. */
    setReservation(which: 'start' | 'stop', minutes: number) {
        const wanted = minutes > 0 ? Date.now() + minutes * 60 * 1000 : undefined
        if (this.resDeadline[which] === wanted) return

        this.resDeadline[which] = wanted
        this.persistReservation()
        log('status', this.id, `reservation ${which}`, minutes > 0 ? `in ${minutes} min` : 'cleared')
        this.publishReservation()
    }

    persistReservation() {
        this.resStore?.save(this.id, this.resDeadline)
    }

    reservationRemaining(which: 'start' | 'stop') {
        const deadline = this.resDeadline[which]
        if (deadline == null) return 0
        return Math.max(0, Math.ceil((deadline - Date.now()) / (60 * 1000)))
    }

    reservationTick() {
        for (const which of ['start', 'stop'] as const) {
            const deadline = this.resDeadline[which]
            if (deadline != null && Date.now() >= deadline) {
                this.resDeadline[which] = undefined
                this.persistReservation()
                this.fireReservation(which)
            }
        }
        /* Republished every minute regardless: it is both the app's countdown and what keeps the
         * reservation keys present in the cloud's snapshot. */
        this.publishReservation()
    }

    fireReservation(which: 'start' | 'stop') {
        const on = which === 'start'
        log('status', this.id, `reservation ${which} due - turning the unit`, on ? 'on' : 'off')

        this.raw_clip_state[TAG_POWER] = on ? 1 : 0
        /* Same tags the power entity attaches: this family ignores a bare power-on write. */
        const tags = on && this.powerOnWithModeWrite ? [TAG_POWER, TAG_MODE, TAG_FAN, TAG_TEMP_TARGET] : [TAG_POWER]
        const fields = tags
            .filter((id) => this.raw_clip_state[id] != null)
            .map((id) => ({ t: id, v: this.raw_clip_state[id] }))
        this.send([1, 1, 2, 1, 1], fields)
    }

    /*
     * Report the reservation bundle upstream as if the appliance had sent it. Without this the
     * cloud has no reservation keys for the device at all and the app's screen cannot open.
     */
    publishReservation() {
        const start = this.reservationRemaining('start')
        const stop = this.reservationRemaining('stop')
        this.raw_clip_state[TAG_RES_START] = start
        this.raw_clip_state[TAG_RES_STOP] = stop

        this.reportUpstream([
            { t: TAG_RES_START, v: start },
            { t: TAG_RES_STOP, v: stop },
            { t: TAG_RES_RELATIVE_START, v: 0 },
            { t: TAG_RES_RELATIVE_STOP, v: 0 },
            { t: TAG_RES_BAN_DISTURB_SLEEP, v: 0 },
            { t: TAG_RES_CANCEL, v: 0 },
            { t: TAG_RES_STOP_HEATING, v: 0 },
        ])
    }

    /*
     * Emit a device->cloud frame in the shape this appliance family uses for an unsolicited
     * report (0xa7 / sub 0x04). Emitting it on the device object feeds both the bridge, which is
     * the point, and our own parser, which keeps the HA entities in step.
     */
    reportUpstream(fields: TLV.TLV[]) {
        const payload = TLV.build(fields)
        let buf = [0x04, 0x00, 0x00, 0x00, 0xa7, 0x02, 0x04, this.resSeq++ & 0xff, payload.length].concat(payload)
        const crc = crc16(buf)
        buf = [0x00, 0x00].concat(buf, [crc >> 8, crc & 0xff])
        this.thinq.emit('data', Buffer.from(buf))
    }

    processPrivData(cmd: number, buf9: number, data: Buffer) {
        if (cmd == 0x02) this.processFilterData(buf9, data)
    }

    processPrivDataCmdResp(success: boolean, buf1: number, cmd: number, data: Buffer) {
        if (cmd == 0x2) this.processFilterCmdResp(success, data)
    }

    sendFilterQuery() {
        this.sendPrivCommand(0x02, 0x02)
    }

    sendFilterReset() {
        if (!this.filterLifeTime) throw new Error('Filter lifetime not known')

        const now = new Date()
        const date = now.getUTCFullYear() * 10000 + (now.getUTCMonth() + 1) * 100 + now.getUTCDate()

        const buf = Buffer.alloc(4 * 3)
        // yes, it's opposite endianness vs read cmd
        buf.writeUInt32BE(this.filterLifeTime, 1 * 4)
        buf.writeUInt32BE(date, 2 * 4)

        log('status', this.id, 'sending filter reset')
        this.sendPrivCommand(0x02, 0x01, buf)
    }

    isCapsResponse(tlvArray: TLV.TLV[]) {
        return tlvArray.some(({ t, v }) => t === TAG_CAPS_EEPROM_CRC)
    }

    isValuesResponse(tlvArray: TLV.TLV[]) {
        return tlvArray.length >= 10 && tlvArray.some(({ t, v }) => t === TAG_POWER)
    }

    valuesReceived() {
        if (this.initialValuesReceived) return
        this.initialValuesReceived = true

        // we want to be informed about all TLV changes - set an empty blacklist
        this.thinq.send('setMaskingInfo', 0, { blacklist_tlv: '1200' })

        // give modem some time to process the command before continuing
        this.tlvBlacklistDisableTimer = setTimeout(() => {
            this.tlvBlacklistDisableTimer = undefined

            if (this.filterStyle() === 'priv') {
                this.initProbeForFilter()
            } else {
                this.initMakeSetConfig()
            }
        }, 500)
    }

    initProbeForFilter() {
        log('status', this.id, 'sending initial filter data query')
        this.sendFilterQuery()

        this.filterInitialQueryTimeout = setTimeout(() => {
            this.filterInitialQueryTimeout = undefined

            log('status', this.id, 'filter data query timeout, assuming no filter')
            this.initMakeSetConfig()
        }, 5 * 1000)
    }

    processFilterData(buf9: number, data: Buffer) {
        if (data.length < 1 + 3 * 4) {
            log('status', this.id, 'filter data too short:', data.length)
            return
        }

        this.filterUsedTime = data.readUInt32LE(1 + 0 * 4)
        this.filterLifeTime = data.readUInt32LE(1 + 1 * 4)
        this.filterChangedDate = data.readUInt32LE(1 + 2 * 4)

        // if this was the initial filter query the device config is ready now
        if (this.filterInitialQueryTimeout != undefined) {
            log('status', this.id, 'received initial filter data')

            clearTimeout(this.filterInitialQueryTimeout)
            this.filterInitialQueryTimeout = undefined

            this.initMakeSetConfig()
        } else {
            // if this was not the initial query just update the HA values
            this.publishFilterData()
        }

        /* The answer to the query the reset button sent. Now the counter is current, clear it. */
        if (this.filterDoReset) {
            this.filterDoReset = false
            this.sendFilterReset()
        }
    }

    publishFilterData() {
        const changedDate =
            Math.floor(this.filterChangedDate / 10000)
                .toString()
                .padStart(4, '0') +
            '-' +
            (Math.floor(this.filterChangedDate / 100) % 100).toString().padStart(2, '0') +
            '-' +
            (this.filterChangedDate % 100).toString().padStart(2, '0')

        this.HA.publishProperty(this.id, 'filterused', this.filterUsedTime)
        this.HA.publishProperty(this.id, 'filterlife', this.filterLifeTime)
        this.HA.publishProperty(this.id, 'filterchangeddate', changedDate)
    }

    processFilterCmdResp(success: boolean, data: Buffer) {
        if (!success) {
            log('status', this.id, 'filter reset failed')
            return
        }

        log('status', this.id, 'filter reset okay, re-querying')
        this.sendFilterQuery()
    }

    updateClimateAction() {
        // also updates query interval
        const mode = this.modeMaps.toLabel.get(this.getModeTLV())

        let iduRunning = true
        const iduRunningTLVNum = this.getIDUActionRunningTLVNum()
        if (iduRunningTLVNum != null) {
            iduRunning = this.raw_clip_state[iduRunningTLVNum] !== 0
        }

        const modes2ha: Record<string, string> = {
            cool: 'cooling',
            dry: 'drying',
            fan_only: 'fan',
            heat: 'heating',
        }
        let action: string | undefined = undefined
        let increaseQueryInterval = false
        if (this.getPowerTLV() === 0) {
            action = 'off'
        } else if (mode != null && mode !== 'fan_only' && !iduRunning) {
            action = 'idle'
        } else if (mode === 'auto') {
            // TODO: figure out how to detect the actual running mode in Auto
            // For now, clear the reported action.
            action = 'None'
            increaseQueryInterval = true // assume it is running
        } else {
            action = mode != null ? modes2ha[mode] : undefined
            increaseQueryInterval = action != null && action !== 'fan'
        }

        if (action != null) this.HA.publishProperty(this.id, 'climate-action', action)
        this.updateQueryInterval(increaseQueryInterval)
    }

    updateQueryInterval(increaseQueryInterval: boolean) {
        if (increaseQueryInterval) {
            if (this.increasedQueryIntervalTimeout != undefined) {
                clearTimeout(this.increasedQueryIntervalTimeout)
                this.increasedQueryIntervalTimeout = undefined
            }

            /*
             * When in one of active modes update more frequently
             * since parameters can change rapidly:
             * every a bit less than half a minute.
             *
             * This matches the observed ODU parameter recalculation intervals:
             * compressor Hz - every 30 seconds,
             * EEV openings - every 30 seconds during transient periods.
             */
            this.setQueryInterval((30 - 2) * 1000)
        } else if (this.increasedQueryIntervalTimeout == null) {
            /*
             * Reset to the default interval after 15 minutes,
             * hopefully things returned to steady idle state by this time.
             */
            this.increasedQueryIntervalTimeout = setTimeout(
                () => {
                    this.increasedQueryIntervalTimeout = undefined
                    this.setQueryInterval()
                },
                15 * 60 * 1000,
            )
        }
    }

    getPowerTLV() {
        return this.raw_clip_state[TAG_POWER]
    }

    getModeTLV() {
        return this.raw_clip_state[TAG_MODE]
    }

    getIDUActionRunningTLVNum() {
        if (this.raw_clip_state[TAG_IDU_THERMO_ON_OFF] != null) return TAG_IDU_THERMO_ON_OFF
        if (this.raw_clip_state[TAG_IDU_RUNNING_ALT] != null) return TAG_IDU_RUNNING_ALT

        return undefined
    }

    /* --- capabilities --- */

    /*
     * Which tag carries each capability bitmap. A model that reports one somewhere else, or that
     * has the tag but with an unrelated meaning, overrides the accessor rather than the
     * individual tests below.
     */
    featureCaps() {
        return this.raw_clip_state[TAG_CAPS_FEATURE]
    }

    jetSwingCaps() {
        return this.raw_clip_state[TAG_CAPS_JET_SWING]
    }

    timerCaps() {
        return this.raw_clip_state[TAG_CAPS_TIMER]
    }

    hasAirPurify() {
        return capBit(this.featureCaps(), CAP_AIR_PURIFY)
    }

    hasEnergySave() {
        return capBit(this.featureCaps(), CAP_ENERGY_SAVE)
    }

    hasAutoDry() {
        return capBit(this.featureCaps(), CAP_AUTO_DRY)
    }

    hasJetCool() {
        return capBit(this.jetSwingCaps(), CAP_JET_COOL)
    }

    hasJetHeat() {
        return capBit(this.jetSwingCaps(), CAP_JET_HEAT)
    }

    hasSwingVertical() {
        return capBit(this.jetSwingCaps(), CAP_SWING_VERTICAL)
    }

    hasSwingHorizontal() {
        return capBit(this.jetSwingCaps(), CAP_SWING_HORIZONTAL)
    }

    hasSleepTimer() {
        return capBit(this.timerCaps(), CAP_SLEEP_TIMER)
    }

    /*
     * Deliberately not read from the capability bitmap, which does advertise the pair on units
     * that have no use for the entities: a schedule the appliance keeps to itself is one Home
     * Assistant cannot see the effect of until it fires. With the relay on it is this driver
     * running the countdown, so there is something to show and the entities are worth having.
     */
    hasStartStopTimers() {
        return this.relayReservation
    }

    /*
     * Which swing axes the unit has, and how each is wired. Derived from the capability bitmap by
     * default: the numbered vane positions on 0x321 / 0x322. A unit whose bitmap does not describe
     * its swing - because it reports the plain on/off pair instead, or because the bitmap does not
     * mention a swing the unit demonstrably has - states its axes here.
     */
    swingAxes(): SwingAxis[] {
        const axes: SwingAxis[] = []
        if (this.hasSwingVertical()) {
            axes.push({ tag: 0x321, name: 'swing_mode', levels: SWING_VERTICAL_POSITIONS })
        }
        if (this.hasSwingHorizontal()) {
            axes.push({ tag: 0x322, name: 'swing_horizontal_mode', levels: SWING_HORIZONTAL_POSITIONS })
        }
        return axes
    }

    /*
     * The two below name which implementation of a feature this class already owns the unit has,
     * rather than turning an independent feature on. One question, one answer each: nothing can
     * ask for two auto-dry entities or two filter accountings at once, and the order this class
     * happens to test them in stops mattering.
     *
     * Entities that this class has no notion of at all are not named here - a model adds those
     * from addModelFields() using the helpers at the end of this file.
     */

    /*
     * How auto dry appears:
     *   'binary'  a diagnostic on/off on 0x20e plus 0x225 as a remaining percentage
     *   'select'  a writable duration on 0x20e (255 = smart), 0x225 counting the running cycle
     *             down in minutes - independent of 0x20e, it only moves while drying runs
     *   'switchLevel'
     *             an on/off enable on 0x20e, a separate 1..5 strength select on its own tag, and
     *             0x225 counting the running cycle down in minutes
     * The binary form is what the 0x2cc feature bit advertises; no bit for either of the other two
     * has been identified, so a unit with one says so.
     */
    autoDryStyle(): 'none' | 'binary' | 'select' | 'switchLevel' {
        return this.hasAutoDry() ? 'binary' : 'none'
    }

    /*
     * The values of the 'select' form's duration tag, or of the 'switchLevel' form's strength tag -
     * whichever this unit has. Only one of the two is ever read.
     */
    readonly autoDryLevels: WireLevels = [
        ['off', 0],
        ['10 min', 1],
        ['30 min', 2],
        ['60 min', 3],
        ['smart', 255],
    ]

    /* 'switchLevel' only: how its enable tag is wired, and which tag carries the strength. */
    readonly autoDryEnableOptions: SwitchOptions = {}

    autoDryLevelTag() {
        return 0x1f2
    }

    /*
     * How filter usage is accounted:
     *   'priv'       the basic-filter priv-command (0x02/0x02), handled above - counters plus a
     *                reset button. Whether the counter it returns is populated is per-model
     *   'valueTags'  plain value tags: 0x356 rated life (constant), 0x355 remaining hours
     *   'valueTagsReset'
     *                the same pair, on a unit that also accepts a write of 0 to 0x355 as a reset -
     *                which is not something to probe for, since a wrong guess writes a lifetime
     *                that contradicts the appliance's own display
     */
    filterStyle(): 'none' | 'priv' | 'valueTags' | 'valueTagsReset' {
        return 'none'
    }

    /* Instantaneous power on 0x2b3, in watts unless powerReadXform() says otherwise. */
    hasPowerSensor() {
        return this.raw_clip_state[0x2b3] != null
    }

    powerReadXform(raw: number): number {
        return raw
    }

    /*
     * Setpoint range in degC. Read from the cooling range the unit advertises in its capabilities;
     * a model that does not report it, or reports one that does not match the unit, overrides this.
     * When it is undefined the range is left out of the discovery config and HA falls back to its
     * own default.
     * TODO: 0x2e3 - 0x2ec carry the ranges of the other modes
     */
    temperatureRange(): { min: number; max: number } | undefined {
        const min = this.raw_clip_state[TAG_CAPS_TEMP_MIN]
        const max = this.raw_clip_state[TAG_CAPS_TEMP_MAX]
        if (min == null || max == null) return undefined
        return { min: min / 2, max: max / 2 }
    }

    /* Entities that only a particular model has. Called just before the config is installed. */
    addModelFields(config: DeviceDiscovery) {
        /* To be overridden if necessary */
    }

    /*
     * Assemble and install the discovery config. Each step below adds the entities for one
     * concern and is a no-op when the unit does not have it; what decides that - a capability
     * bit, a tag being reported, a per-model answer - is stated at the top of each.
     */
    initMakeSetConfig() {
        const config = this.makeClimateConfig()

        this.addClimateCore(config)
        this.addDiagnosticSensors(config)
        this.addFeatureEntities(config)
        this.addAutoDryEntities(config)
        this.addClimateActionField(config)
        this.addFilterEntities(config)
        this.addPowerSensor(config)
        this.addModelFields(config)

        this.setConfig(config)
        this.startFilterRefresh()
        this.query()
    }

    /*
     * The climate component itself: the setpoint range and resolution, and the mode, fan and
     * (from addClimateCore) swing lists this unit offers.
     */
    makeClimateConfig(): ClimateConfig {
        const range = this.temperatureRange()
        const config: ClimateConfig = allowExtendedType({
            ...HADevice.config(this.meta, { name: this.haDeviceName }),
            components: {
                climate: {
                    platform: 'climate',
                    unique_id: '$deviceid-climate',
                    name: null,
                    action_topic: '$this/climate-action',
                    temperature_unit: 'C',
                    temp_step: this.tempStep,
                    precision: this.tempStep,
                    ...(range != null ? { min_temp: range.min, max_temp: range.max } : {}),
                    fan_modes: this.haFanModes,
                    modes: this.haModes,
                } satisfies ClimateComponent,
            },
        })

        return config
    }

    /*
     * Power, mode, fan, both temperatures and the swing axes - the tags every unit on this
     * scheme has, and the only ones that are not conditional.
     */
    addClimateCore(config: ClimateConfig) {
        this.addField(config, {
            id: TAG_TEMP_CURRENT,
            name: 'current_temperature',
            comp: 'climate',
            state_topic: 'topic',
            writable: false,
            read_xform: (raw) => raw / 2,
        })
        this.addField(config, {
            id: TAG_POWER,
            name: 'power',
            comp: 'climate',
            readable: false,
            ...SWITCH_XFORM,
            /*  0x1f7 is not necessary for ON but does not seem to hurt either */
            write_attach: (raw) => (raw ? [TAG_MODE, TAG_FAN, TAG_TEMP_TARGET] : []),
            read_callback: (val) => {
                /*
                 * Update 'mode' instead.
                 *
                 * This is also why a hook that is already on modeChangeHooks does not belong on
                 * powerChangeHooks: mode reads as 'off' while the unit is off and as its actual
                 * mode otherwise, so every power change is a mode change too and a hook on both
                 * lists runs twice for one event.
                 */
                this.processKeyValue(TAG_MODE, this.raw_clip_state[TAG_MODE])

                /* After the mode update, in case a hook depends on it being current. */
                const powerState = val === 'ON'
                if (this.powerStatePrev !== powerState) for (const hook of this.powerChangeHooks) hook()
                this.powerStatePrev = powerState

                return false
            },
        })

        this.addField(config, {
            id: TAG_MODE,
            name: 'mode',
            comp: 'climate',
            read_xform: (raw) => {
                if (this.getPowerTLV() === 0) return 'off'
                return this.modeMaps.toLabel.get(raw)
            },
            read_callback: (val) => {
                if (typeof val !== 'string') return true
                if (this.modePrev !== val) for (const hook of this.modeChangeHooks) hook()
                this.modePrev = val
                return true
            },
            write_xform: (val) => {
                if (val === 'off') {
                    // Call function power (0x1f7) with value OFF
                    this.setProperty('climate-power', 'OFF')
                    return null
                }
                // Some units ignore a mode write while powered off - the app turns them on by
                // sending 0x1f7=1 together with the mode, so do the same.
                if (this.powerOnWithModeWrite) this.raw_clip_state[TAG_POWER] = 1
                return this.modeMaps.toWire.get(val)
            },
            write_attach: this.powerOnWithModeWrite
                ? [TAG_POWER, TAG_FAN, TAG_TEMP_TARGET]
                : [TAG_FAN, TAG_TEMP_TARGET],
        })

        this.addField(config, {
            id: TAG_FAN,
            name: 'fan_mode',
            comp: 'climate',
            read_xform: (raw) => this.fanMaps.toLabel.get(raw),
            write_xform: (val) => this.fanMaps.toWire.get(val),
            write_attach: [TAG_MODE, TAG_TEMP_TARGET],
            read_callback: (val) => {
                if (this.fanPrev !== val) for (const hook of this.fanChangeHooks) hook()
                this.fanPrev = val
                return true
            },
        })

        this.addField(config, {
            id: TAG_TEMP_TARGET,
            name: 'temperature',
            comp: 'climate',
            read_xform: (raw) => raw / 2,
            /*
             * HA is told the range and will not offer anything outside it, so the clamp only
             * catches a setpoint arriving from elsewhere - which the unit would reject anyway.
             */
            write_xform: (val) => {
                const range = this.temperatureRange()
                const degC = range == null ? Number(val) : Math.min(Math.max(Number(val), range.min), range.max)
                return Math.round(degC * 2)
            },
            write_attach: [TAG_MODE, TAG_FAN],
        })

        for (const axis of this.swingAxes()) {
            this.addSwingField(config, axis)
        }
    }

    /*
     * Read-only diagnostics, each added only if the unit reports its tag.
     *
     * 0x21f - "display light" value is inverted in some devices, but in some devices it is
     * not - not shown in the ThinQ app either, so it is not exposed here.
     */
    addDiagnosticSensors(config: ClimateConfig) {
        this.addOptionalSensorField(config, 0x221, 'error', 'Error code', 'mdi:alert')
        this.addOptionalSensorField(
            config,
            0x32e,
            'capacity',
            'Capacity nominal',
            undefined,
            {
                device_class: 'power',
                unit_of_measurement: 'kW',
                suggested_display_precision: 1,
            },
            (raw) => (raw !== 0 ? Math.round(raw * 0.293 * 10) / 10 : undefined),
        ) // raw is in kBTU / hour

        /*
         * Whether the IDU will report its EEV opening correctly during its
         * active operation is highly inconsistent between IDUs.
         * For example, from two Standard2 IDUs with 0x690409 software version
         * connected to common ODU one IDU works as expected while the other
         * one reports the EEV opening value of the other Standard2 IDU (?).
         * This may be an ODU firmware bug. On the other hand, another Deluxe
         * IDU connected to the same ODU always reports correct EEV values.
         * None of tested IDUs seem to usually notify by itself when this value changes.
         */
        this.addOptionalSensorField(config, 0x330, 'eev', 'EEV opening', 'mdi:valve', {
            state_class: 'measurement',
            suggested_display_precision: 0,
        })

        /*
         * IDUs send notifications about the updates of the temperatures below
         * at their own pace, sometimes in clusters with other attributes.
         * Deluxe IDUs send notifications noticeably more often than Standard2 IDUs.
         *
         * Pipe temps are sometimes reported as 0 (-100 C) for a moment after a shutdown.
         * Make sure to filter out such updates.
         */
        this.addOptionalSensorTempField(
            config,
            0x2f9,
            'pipeintemp',
            'Pipe liquid temperature',
            'mdi:pipe',
            (raw) => racPipeTemp[255 - raw],
        )
        this.addOptionalSensorTempField(
            config,
            0x2fa,
            'pipeouttemp',
            'Pipe gas temperature',
            'mdi:pipe',
            (raw) => racPipeTemp[255 - raw],
        )

        this.addOptionalSensorTempField(
            config,
            [0x7a, 0x32c],
            'oduhextemp',
            'ODU HEX temperature', // "HEX" = "heat exchanger"
            'mdi:heating-coil',
            (raw) => racPipeTemp[255 - raw],
        )
        this.addOptionalSensorTempField(
            config,
            0x332,
            'oduairtemp',
            'ODU air temperature',
            'mdi:thermometer-lines',
            (raw) => racAirTemp[255 - raw],
        )

        /*
         * [ 0x22a, 0x32f ] - ODU compressor Hz
         * Standard2 IDUs even notify about the former
         * tag changes.
         *
         * But the value seems to be capped at 15 Hz
         * regardless of the actual compressor speed,
         * which makes it of limited usability.
         */

        // 0x2fb is the target fan RPM, while this is the current RPM
        this.addOptionalSensorField(
            config,
            0x331,
            'fanrpm',
            'Fan RPM',
            'mdi:fan',
            {
                state_class: 'measurement',
                unit_of_measurement: 'rpm',
                suggested_display_precision: 0,
            },
            (raw) => raw * 10,
        )
    }

    /*
     * The entities behind the capability bitmaps: air purify, jet, the timers and energy
     * saving. Auto dry is the other bit in that bitmap but has two forms, so it is separate.
     */
    addFeatureEntities(config: ClimateConfig) {
        if (this.hasAirPurify()) {
            this.addModeDependentConfigSwitchField(
                config,
                0x20f,
                'airclean',
                /* Same desc as in lg_thinq */
                'Air purify',
                'mdi:air-purifier',
                'airClean',
            )
        }

        const jetCool = this.hasJetCool()
        const jetHeat = this.hasJetHeat()
        if (jetCool || jetHeat) {
            this.addJetField(config, 0x323, 'jet', 'Jet', 'mdi:wind-power', jetCool, jetHeat)
        }

        if (this.hasSleepTimer()) {
            // 15h by default - displayed in hex as "FH"
            this.addTimerField(config, 0x21a, 'sleeptimer', 'Sleep timer', 'mdi:bed-clock', this.sleepTimerMaxMinutes)
        }

        if (this.hasStartStopTimers()) {
            this.addTimerField(config, 0x21c, 'starttimer', 'Turn-on timer', 'mdi:timer-play', 24 * 60)
            this.addTimerField(config, 0x21b, 'stoptimer', 'Turn-off timer', 'mdi:timer-stop', 24 * 60)
        }

        if (this.hasEnergySave()) {
            // Can be enabled only when running in the cooling mode
            this.addModeDependentConfigSwitchField(
                config,
                0x20d,
                'energysave',
                'Energy saving',
                'mdi:flower',
                'energySave',
                (mode) => mode === this.modeMaps.toWire.get('cool'),
            )
        }
    }

    /*
     * Auto dry, in whichever of its two forms this unit has. See autoDryStyle().
     */
    addAutoDryEntities(config: ClimateConfig) {
        if (this.autoDryStyle() === 'select') {
            /*
             * The select variant: 0x20e picks the drying duration (255 = smart) and 0x225 is the
             * number of minutes left in the running cycle - independent of 0x20e, it only changes
             * while drying runs.
             */
            this.addValueSelect(
                config,
                'autodry_setting',
                TAG_AUTO_DRY,
                'Auto dry',
                'mdi:hair-dryer',
                this.autoDryLevels,
            )

            this.addOptionalSensorField(
                config,
                TAG_AUTO_DRY_REMAIN,
                'autodryremain',
                'Auto dry remaining',
                'mdi:hair-dryer-outline',
                {
                    device_class: 'duration',
                    unit_of_measurement: 'min',
                    suggested_display_precision: 0,
                },
            )
        } else if (this.autoDryStyle() === 'binary') {
            config['components']['autodry'] = allowExtendedType({
                platform: 'binary_sensor',
                unique_id: '$deviceid-autodry',
                name: 'Auto dry',
                icon: 'mdi:hair-dryer',
                entity_category: 'diagnostic',
            })
            this.addField(config, {
                id: TAG_AUTO_DRY,
                name: '',
                comp: 'autodry',
                writable: false,
                read_xform: (raw) => (raw ? 'ON' : 'OFF'),
            })

            /* here 0x225 is the percentage of the cycle left, not a number of minutes */
            this.addSensorField(
                config,
                TAG_AUTO_DRY_REMAIN,
                'autodryremain',
                'Auto dry remaining',
                'mdi:hair-dryer-outline',
                {
                    unit_of_measurement: '%',
                    suggested_display_precision: 0,
                },
            )
        } else if (this.autoDryStyle() === 'switchLevel') {
            /*
             * Enable and strength on two tags rather than one duration. The enable is a plain
             * on/off - on the stand units it reads 0 or 255 and nothing else, so presenting it as
             * the select variant's "10 min / 30 min / 60 min" would be inventing options - and the
             * strength is its own 1..5 select on a second tag the other two forms do not have.
             */
            this.addConfigSwitchField(
                config,
                TAG_AUTO_DRY,
                'autodry',
                'Auto dry',
                'mdi:hair-dryer',
                this.autoDryEnableOptions,
            )
            this.addValueSelect(
                config,
                'autodrylevel',
                this.autoDryLevelTag(),
                'Auto dry level',
                'mdi:hair-dryer-outline',
                this.autoDryLevels,
            )

            /* minutes here, measured against the appliance's own display, not a percentage */
            this.addOptionalSensorField(
                config,
                TAG_AUTO_DRY_REMAIN,
                'autodryremain',
                'Auto dry remaining',
                'mdi:hair-dryer-outline',
                {
                    device_class: 'duration',
                    unit_of_measurement: 'min',
                    suggested_display_precision: 0,
                },
            )
        }
    }

    /*
     * What the unit is actually doing. The tag that reports it only exists on some units; the
     * mode hook recomputes the action either way, power included - see the note on that hook.
     */
    addClimateActionField(config: ClimateConfig) {
        const iduRunningTag = this.getIDUActionRunningTLVNum()
        if (iduRunningTag != null) {
            this.addField(
                config,
                {
                    id: iduRunningTag,
                    name: 'action',
                    comp: 'climate',
                    read_callback: (val) => {
                        this.updateClimateAction()
                        return false
                    },
                },
                false,
            )
        }

        this.modeChangeHooks.push(() => {
            this.updateClimateAction()
        })
    }

    /*
     * Filter usage, in whichever of its two forms this unit has. See filterStyle(). The
     * priv-command form depends on filterLifeTime, which the initial probe has filled in by
     * now if the unit answered it.
     */
    addFilterEntities(config: ClimateConfig) {
        if (this.filterLifeTime) {
            /* All three are published from processFilterData(), not from a tag. */
            this.addPublishedSensor(config, 'filterused', 'Filter used time', {
                icon: 'mdi:air-filter',
                device_class: 'duration',
                unit_of_measurement: 'h',
                state_class: 'total_increasing',
                entity_category: 'diagnostic',
            })
            this.addPublishedSensor(config, 'filterlife', 'Filter life time', {
                icon: 'mdi:air-filter',
                device_class: 'duration',
                unit_of_measurement: 'h',
                entity_category: 'diagnostic',
            })
            /* NB: the component key is 'changeddate' while the entity is 'filterchangeddate' */
            this.addPublishedSensor(
                config,
                'filterchangeddate',
                'Filter usage last reset',
                {
                    icon: 'mdi:calendar-refresh-outline',
                    device_class: 'date',
                    entity_category: 'diagnostic',
                },
                'changeddate',
            )

            config['components']['filterreset'] = allowExtendedType({
                platform: 'button',
                unique_id: '$deviceid-filterreset',
                command_topic: '$this/filterreset/set',
                name: 'Reset filter usage',
                icon: 'mdi:calendar-refresh-outline',
                entity_category: 'diagnostic',
            })
            this.fields_by_ha['filterreset'] = {
                name: '',
                comp: '',
                write_xform: (val) => (val === 'PRESS' ? 1 : 0),
                write_callback: (val) => {
                    if (val === 1) {
                        /*
                         * Query first, reset when the answer arrives. These counters are only
                         * refreshed once a day - a query may do an EEPROM write - so resetting
                         * straight away records a usage figure up to 24 hours short of what the
                         * filter actually ran.
                         */
                        this.filterDoReset = true
                        this.sendFilterQuery()
                    }
                    return false
                },
            }
        }

        const valueTags = this.filterStyle() === 'valueTags' || this.filterStyle() === 'valueTagsReset'
        if (valueTags && this.raw_clip_state[TAG_FILTER_LIFE]) {
            /*
             * All of these are published from a read hook on 0x355, the live counter (0x356 is
             * the constant rated life); used = life - remaining, remaining % = remaining / life.
             */
            this.addPublishedSensor(config, 'filter_remaining', 'Filter remaining', {
                icon: 'mdi:air-filter',
                unit_of_measurement: '%',
                state_class: 'measurement',
                suggested_display_precision: 0,
                entity_category: 'diagnostic',
            })
            this.addPublishedSensor(config, 'filter_life', 'Filter life time', {
                icon: 'mdi:air-filter',
                device_class: 'duration',
                unit_of_measurement: 'h',
                entity_category: 'diagnostic',
            })
            this.addPublishedSensor(config, 'filter_used', 'Filter used time', {
                icon: 'mdi:air-filter',
                device_class: 'duration',
                unit_of_measurement: 'h',
                state_class: 'total_increasing',
                entity_category: 'diagnostic',
            })
            this.addField(
                config,
                {
                    id: TAG_FILTER_REMAINING,
                    name: '',
                    comp: 'filter_remaining',
                    readable: false,
                    writable: false,
                    read_callback: () => {
                        const life = this.raw_clip_state[TAG_FILTER_LIFE]
                        const remaining = this.raw_clip_state[TAG_FILTER_REMAINING]
                        if (life) {
                            this.HA.publishProperty(this.id, 'filter_remaining', Math.round((remaining / life) * 100))
                            this.HA.publishProperty(this.id, 'filter_used', life - remaining)
                            this.HA.publishProperty(this.id, 'filter_life', life)
                        }
                        return false
                    },
                },
                false,
            )

            /*
             * These tags are not read-only everywhere. On the stand units the official app resets
             * the counter with a plain TLV write of 0 to 0x355, and the appliance answers by
             * reporting 0x355 = 0x356 - a full life again.
             *
             * Wired through fields_by_ha rather than addField because addField would claim
             * fields_by_id[0x355], which the read hook above already owns, and the derived sensors
             * would stop updating. The callback sends the frame itself and returns false so the
             * default write path does not also stamp 0 into raw_clip_state: the appliance's own
             * reply is what should move the sensors, so a reset it ignores leaves HA telling the
             * truth.
             */
            if (this.filterStyle() === 'valueTagsReset') {
                config['components']['filterreset'] = allowExtendedType({
                    platform: 'button',
                    unique_id: '$deviceid-filterreset',
                    command_topic: '$this/filterreset/set',
                    name: 'Reset filter usage',
                    icon: 'mdi:air-filter',
                    entity_category: 'diagnostic',
                })
                this.fields_by_ha['filterreset'] = {
                    name: '',
                    comp: '',
                    write_xform: (val) => (val === 'PRESS' ? 0 : null),
                    write_callback: () => {
                        log('status', this.id, 'resetting the filter counter')
                        this.send([1, 1, 2, 1, 1], [{ t: TAG_FILTER_REMAINING, v: 0 }])
                        return false
                    },
                }
            }
        }
    }

    /*
     * Instantaneous power draw, if the unit reports it.
     */
    addPowerSensor(config: ClimateConfig) {
        if (this.hasPowerSensor()) {
            /* a primary sensor rather than a diagnostic one, hence the entity_category override */
            this.addSensorField(
                config,
                TAG_POWER_W,
                'energy_current',
                'Power',
                undefined,
                {
                    entity_category: undefined,
                    device_class: 'power',
                    unit_of_measurement: 'W',
                    state_class: 'measurement',
                    suggested_display_precision: 0,
                },
                (raw) => this.powerReadXform(raw),
            )
        }
    }

    /*
     * Keep the priv-command filter counters fresh. Only once a day, since a query might do an
     * EEPROM write.
     */
    startFilterRefresh() {
        if (!this.filterLifeTime) return

        this.publishFilterData()

        this.filterQueryTimer = setInterval(
            () => {
                log('status', this.id, 'sending periodic filter data refresh query')
                this.sendFilterQuery()
            },
            24 * 60 * 60 * 1000,
        )
    }

    /*
     * A timer, in minutes. `box` rather than `slider`: a minute-resolution timer is set by typing
     * a number, and an HA number entity has one display mode, so a second slider entity would
     * only be a second row saying the same thing. A dashboard that wants to drag can add the
     * tile card's numeric-input feature, which draws a slider for this entity either way.
     *
     * Minutes rather than hours because that is what the wire carries and what a running timer
     * counts down in - the entity's own value is the time left.
     */
    addTimerField(config: DeviceDiscovery, id: number, name: string, desc: string, icon: string, maxMinutes: number) {
        const comp = {
            platform: 'number',
            unique_id: '$deviceid-' + name,
            name: desc,
            icon: icon,
            device_class: 'duration',
            unit_of_measurement: 'min',
            min: 0,
            max: maxMinutes,
            step: 1,
            mode: 'box',
        } as const
        config['components'][name] = comp

        /*
         * Upon setting this field the device starts counting down and
         * every minute sends the remaining time.
         *
         * The write transform is not optional even though minutes go on the wire as they come in:
         * setProperty drops a write whose field has no write_xform.
         */
        this.addField(config, { id: id, name: '', comp: name, write_xform: (val) => Math.round(Number(val)) })
    }

    addJetField(
        config: DeviceDiscovery,
        id: number,
        name: string,
        desc: string,
        icon: string,
        jetCool: boolean,
        jetHeat: boolean,
    ) {
        const descFull =
            desc + ' ' + (jetCool ? 'cool' : '') + (jetCool && jetHeat ? '/' : '') + (jetHeat ? 'heat' : '')

        const comp = {
            platform: 'switch',
            unique_id: '$deviceid-' + name,
            name: descFull,
            icon: icon,
            entity_category: 'config',
            optimistic: true,
        }
        config['components'][name] = comp

        const coolWire = this.modeMaps.toWire.get('cool')
        const heatWire = this.modeMaps.toWire.get('heat')

        this.addField(config, {
            id: id,
            name: '',
            comp: name,
            write_xform: (val) => {
                this.jetMode = val === 'ON'
                if (!this.jetMode) return 0

                /* ON */
                if (jetCool && this.getModeTLV() === coolWire) return 1
                if (jetHeat && this.getModeTLV() === heatWire) return 2
                return 0
            },
            read_xform: (raw) => {
                if (jetCool && this.getModeTLV() === coolWire && raw == 1) return 'ON'
                if (jetHeat && this.getModeTLV() === heatWire && raw == 2) return 'ON'
                return 'OFF'
            },
            read_callback: (val) => {
                // Ignore read value if not running
                const powerTLV = this.getPowerTLV()
                if (powerTLV === 0 || powerTLV == null) return false

                // Ignore read value if not in the right mode
                if (!((jetCool && this.getModeTLV() === coolWire) || (jetHeat && this.getModeTLV() === heatWire)))
                    return false

                this.jetMode = val === 'ON'
                return true
            },
            write_callback: (val) => {
                /*
                 * Writing '1' in OFF state seem to immediately
                 * power on into the cooling mode, while writing
                 * '2' in the OFF state is ignored.
                 * Be consistent and only allow enabling Jet mode
                 * when running in the right mode.
                 */
                return (
                    this.getPowerTLV() !== 0 &&
                    ((jetCool && this.getModeTLV() === coolWire) || (jetHeat && this.getModeTLV() === heatWire))
                )
            },
        })

        /*
         * This value needs to be written at each power up in heat/cool mode,
         * but in a separate message. The mode hook covers power-up as well - see the power
         * field's read callback - so registering the same write on both lists only sent it twice.
         */
        this.modeChangeHooks.push(() => {
            this.setProperty(name + '-', this.jetMode ? 'ON' : 'OFF')
        })
    }

    /*
     * A diagnostic sensor fed straight from one tag. addOptionalSensorField picks the first of
     * `ids` the unit actually reports and does nothing if it reports none of them; addSensorField
     * declares the entity unconditionally, for a tag whose presence has already been established.
     */
    addSensorField(
        config: DeviceDiscovery,
        id: number,
        name: string,
        desc: string,
        icon?: string,
        extra?: Record<string, unknown>,
        read_xform?: FieldDefinition['read_xform'],
    ) {
        config['components'][name] = allowExtendedType({
            icon: icon ?? undefined,
            platform: 'sensor',
            unique_id: '$deviceid-' + name,
            name: desc,
            entity_category: 'diagnostic',
            ...extra,
        })

        this.addField(config, {
            id: id,
            name: '',
            comp: name,
            writable: false,
            read_xform: read_xform,
        })
    }

    addOptionalSensorField(
        config: DeviceDiscovery,
        ids: number | number[],
        name: string,
        desc: string,
        icon?: string,
        extra?: Record<string, unknown>,
        read_xform?: FieldDefinition['read_xform'],
    ) {
        if (typeof ids === 'number') {
            ids = [ids]
        }

        const id = ids.find(
            (val) =>
                this.raw_clip_state[val] != null &&
                (read_xform == null || read_xform(this.raw_clip_state[val]) != null),
        )
        if (id == null) return

        this.addSensorField(config, id, name, desc, icon, extra, read_xform)
    }

    /*
     * A sensor this class publishes by hand rather than through a TLV field, for values that are
     * computed from several tags or that arrive outside the TLV stream altogether. The caller
     * publishes to `$this/<name>`; `comp` defaults to the same name.
     */
    addPublishedSensor(
        config: DeviceDiscovery,
        name: string,
        desc: string,
        extra: Record<string, unknown>,
        comp: string = name,
    ) {
        config['components'][comp] = allowExtendedType({
            platform: 'sensor',
            unique_id: '$deviceid-' + name,
            state_topic: '$this/' + name,
            name: desc,
            ...extra,
        })
    }

    addOptionalSensorTempField(
        config: DeviceDiscovery,
        ids: number | number[],
        name: string,
        desc: string,
        icon?: string,
        read_xform?: FieldDefinition['read_xform'],
    ) {
        this.addOptionalSensorField(
            config,
            ids,
            name,
            desc,
            icon,
            {
                device_class: 'temperature',
                unit_of_measurement: '°C',
                state_class: 'measurement',
                suggested_display_precision: 2,
            },
            read_xform,
        )
    }

    /*
     * A config-category switch component.
     *
     * `entityCategory` decides where HA files the entity on the device page: 'config' puts it under
     * Configuration, 'diagnostic' under Diagnostic, and NO KEY AT ALL under Controls. There is no
     * string meaning Controls, so an everyday control needs the key absent - which is why an
     * explicit `undefined` has to be told apart from the caller saying nothing, and why this
     * spreads an object rather than assigning a value. `entity_category: undefined` is not good
     * enough: JSON.stringify drops it on the wire but the component object the tests read still
     * carries the key.
     */
    addSwitchComponent(
        config: DeviceDiscovery,
        name: string,
        desc: string,
        icon: string,
        optimistic: boolean,
        options: SwitchOptions = {},
    ) {
        const category = 'entityCategory' in options ? options.entityCategory : 'config'
        config['components'][name] = allowExtendedType({
            platform: 'switch',
            unique_id: '$deviceid-' + name,
            name: desc,
            icon: icon,
            ...(category === undefined ? {} : { entity_category: category }),
            ...(optimistic ? { optimistic: true } : {}),
        })
    }

    addConfigSwitchField(
        config: DeviceDiscovery,
        id: number,
        name: string,
        desc: string,
        icon: string,
        options: SwitchOptions = {},
    ) {
        this.addSwitchComponent(config, name, desc, icon, false, options)

        this.addField(config, {
            id: id,
            name: '',
            comp: name,
            ...switchXform(options),
        })
    }

    addModeDependentConfigSwitchField(
        config: DeviceDiscovery,
        id: number,
        name: string,
        desc: string,
        icon: string,
        field_name: 'airClean' | 'jetMode' | 'energySave',
        check_mode?: CheckMode,
    ) {
        this.addSwitchComponent(config, name, desc, icon, this.modeDependentSwitchOptimistic)

        this.addField(config, {
            id: id,
            name: '',
            comp: name,
            ...SWITCH_XFORM,
            read_callback: (val) => {
                // Ignore read value if not running
                const powerTLV = this.getPowerTLV()
                if (powerTLV === 0 || powerTLV == null) return false

                // Ignore read value if not in the right mode
                if (check_mode && !check_mode(this.getModeTLV())) return false

                this[field_name] = val === 'ON'
                return true
            },
            write_callback: (val) => {
                this[field_name] = val === 1

                // No need to write the value if not running in the right mode
                return this.getPowerTLV() !== 0 && (!check_mode || check_mode(this.getModeTLV()))
            },
        })

        /*
         * This value needs to be written at each power up, but in a separate message.
         *
         * One list or the other, never both: a mode-dependent switch already gets its write on
         * every power change, because power changes the mode too - see the power field's read
         * callback. A switch that has no check_mode has no mode hook to ride, so it keeps the
         * power one.
         */
        if (check_mode) {
            this.modeChangeHooks.push(() => {
                this.setProperty(name + '-', this[field_name] ? 'ON' : 'OFF')
            })
        } else {
            this.powerChangeHooks.push(() => {
                if (this.getPowerTLV() === 0) return
                this.setProperty(name + '-', this[field_name] ? 'ON' : 'OFF')
            })
        }
    }

    /*
     * Register a writable HA select whose options map one-to-one to wire values. The
     * [label, wire] list is the single source of truth - the option list and both the read and
     * write transforms are derived from it, so they can't drift out of sync.
     */
    addValueSelect(config: DeviceDiscovery, comp: string, id: number, name: string, icon: string, levels: WireLevels) {
        if (this.raw_clip_state[id] == null || config.components[comp]) return
        const { labels, toLabel, toWire } = wireMaps(levels)
        config.components[comp] = allowExtendedType({
            platform: 'select',
            unique_id: `$deviceid-${comp}`,
            name,
            icon,
            entity_category: 'config',
            options: labels,
        })
        this.addField(config, {
            id,
            name: '',
            comp,
            read_xform: (raw) => toLabel.get(raw),
            write_xform: (val) => toWire.get(val),
        })
    }

    /*
     * Swing along one axis, as an attribute of the climate component rather than an entity of its
     * own. Same [label, wire] contract as addValueSelect: the mode list HA is offered and both
     * transforms come from the one list.
     */
    addSwingField(config: ClimateConfig, axis: SwingAxis) {
        const { labels, toLabel, toWire } = wireMaps(axis.levels)
        const attr = axis.name === 'swing_mode' ? 'swing_modes' : 'swing_horizontal_modes'
        config['components']['climate'][attr] = labels
        this.addField(config, {
            id: axis.tag,
            name: axis.name,
            comp: 'climate',
            read_xform: (raw) => toLabel.get(raw),
            write_xform: (val) => toWire.get(val),
            ...(axis.attach != null ? { write_attach: axis.attach } : {}),
        })
    }
}
