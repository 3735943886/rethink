import TLVDevice, { FieldDefinition } from './tlv_device'
import { Device as Thinq2Device } from '../thinq2/device'
import { ComponentInfo, DeviceDiscovery, type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import * as TLV from '@/util/tlv'
import crc16 from '@/util/crc16'
import HADevice from './base'

/**
 * LG dehumidifier
 * ThinQ model DHUM_231006_WW (swVersion 1663, deviceType 403, platform thinq2)
 *
 * First deviceType 403 profile in the project. Everything below was measured on one live
 * appliance: its owner drove it from the LG ThinQ app, one setting at a time, naming each
 * action, while the frames were recorded through rethink's management /device socket. The
 * appliance confirms every write with a state frame carrying the same tag ~0.5 s later, so
 * each label rests on a matched (write, echo, human name) triple rather than on a guess.
 *
 * QUIRK, same as PAC_910604_WW: state frames are marked 0xa7 at buf[6], not 0x87, so the
 * base class' processData() would drop all of them. processData() below widens the marker
 * test and delegates the rest, following PAC_910604_WW / POT_056905_WW.
 *
 * The capability reply (queryCaps(), TLV 0x1f5 = 1) and the values dump (query(),
 * TLV 0x1f5 = 2) were both obtained from the live appliance before this profile existed, by
 * injecting the exact frames TLVDevice sends. That matters: isCapsResponse() and
 * isValuesResponse() below are the two predicates whose failure mode is a silent 15-second
 * retry loop against the appliance forever, and both are measured here, not assumed.
 *
 * DELIBERATELY NOT MAPPED - all of these are seen in the frames and none has a label:
 *   0x232 / 0x233   move together, seen 861/1, 0/12, 0/24, 0/28, 24/19. PAC_910604_WW
 *                   leaves the same pair unmapped.
 *   0x173 = 5641235, 0x174 = 1376511   constant over the whole session, 3-byte counters
 *   0x3b9 = 4, 0x3ec, 0x350, 0x374, 0x2af   constant
 *   0x21c, 0x226, 0x324, 0x33a, 0x2ac, 0x186, 0x3ea   zero throughout
 *   0x360           tracks 0x1f7 exactly in both observed power transitions (1 while on,
 *                   0 while off). Two observations cannot separate "second power flag" from
 *                   "something that merely agreed twice", so it publishes nothing.
 *   0x3eb           the app writes 0x3eb = 0 about a second after each power-off, twice out
 *                   of two. Unnamed, and this profile never sends it.
 *   mode 22         the appliance's own (0x2d7, 0x2d8, 0x2d9) triple table in state frames
 *                   lists a fifth mode value, 22, that the app does not offer. Writing
 *                   0x1f9 = 22 to the live appliance was ACKed and its remembered fan was
 *                   applied, but the appliance never reported 0x1f9 = 22 back, and the
 *                   capability reply's mode list does not contain it (see MODES below).
 *                   Not exposed: unnamed, unselectable, and unconfirmed as a mode.
 *   the 0xa8 family (97 bytes, buf[7] = 0x66/0x67) and the 190-byte 0x87/0xfd/0x03 frames
 *                   share this appliance's envelope but their payloads are NOT TLV - parsing
 *                   them as TLV yields nonsense (tag 0x0 repeated, values of 16777215).
 *                   processData() below does not accept them.
 *
 * Three tags LEFT that list on 2026-07-31 and are now the water tank's light: 0x21e, 0x3e0
 * and 0x185 sat at 0, 0 and 120 for an entire session purely because nobody had touched the
 * light. "Constant" and "unused" are not the same thing - worth remembering about the rest
 * of the list above.
 */

/* HA's MQTT humidifier: on/off + target humidity + a mode list. */
type HumidifierComponent = ComponentInfo & {
    platform: 'humidifier'
    device_class?: 'humidifier' | 'dehumidifier'
    min_humidity?: number
    max_humidity?: number
    modes?: string[]
}
type DehumDiscovery = DeviceDiscovery & { components: { humidifier: HumidifierComponent } }

/*
 * Operating modes, TLV 0x1f9. Non-contiguous, so this is a value map and not an offset into
 * a list. Each pairing is one app selection and the appliance's own echo of it:
 *
 *   86  0x56  스마트플러스   'smart plus'    the mode the appliance was found in
 *   19  0x13  저소음제습     'quiet'         low-noise dehumidify
 *   85  0x55  쾌속의류       'fast laundry'  fast clothes drying
 *   20  0x14  집중건조       'focused dry'
 *
 * The capability reply lists exactly these four as 0x2d7 entries (86, 19, 85, 20) - the
 * appliance's own declaration, agreeing with what the owner can select in the app.
 *
 * NOTE for anyone tempted to read the mode list out of 0x2c1 the way the AC profiles do:
 * it cannot work here. This appliance's caps reply carries 0x2c1 = 0x180000, i.e. bits 19
 * and 20 - modes 19 and 20 only. Modes 85 and 86 do not fit in a 32-bit mask over wire
 * values, so on this model the 0x2d7 list is the complete one and the bitmask is not.
 */
const MODES: Array<[number, string]> = [
    [86, 'smart plus'],
    [19, 'quiet'],
    [85, 'fast laundry'],
    [20, 'focused dry'],
]

/*
 * Fan speed, TLV 0x1fa. Swept 약 -> 중 -> 강 -> 터보 -> 약 -> 강 -> 자동 and every step
 * echoed; the sweep returning to values it had already visited is what makes it
 * self-checking. 3 and 5 were never offered by the app and are absent here.
 *
 * Independently confirmed by the appliance: the capability reply's 0x2c2 = 0x751d4 has bits
 * 2, 4, 6, 7 and 8 set - exactly these five values - which is the same "selectable fan
 * levels" mask the AC profiles use. (The mask's high bits 12, 14, 16, 17, 18 are unexplained
 * here as they are there.)
 */
const FAN_SPEEDS: Array<[number, string]> = [
    [2, 'low'],
    [4, 'medium'],
    [6, 'high'],
    [7, 'turbo'],
    [8, 'auto'],
]

/*
 * Airflow aim, TLV 0x189. Contiguous 0..3, swept in app order 공간 / 다용도 / 포커스 /
 * 상하회전 with all four echoed.
 *
 * DO NOT port this tag from the AC profiles. RAC_056905_WW reads 0x189 as the indoor-unit
 * thermo-on flag; on this appliance it is a four-way airflow selector that the app writes.
 * Two things say so: the four writes and their four echoes above, and the fact that a mode
 * change carries a new 0x189 with it (selecting 쾌속의류 brought 0x189 = 3, 스마트플러스
 * brought 0x189 = 1) - a per-mode remembered aim, which a run flag would not have.
 */
const AIRFLOW = ['space', 'multi', 'focus', 'swing']

/*
 * Auto-dry of the appliance's own interior, TLV 0x20e. Non-contiguous, and 253 is not a
 * duration but the appliance's "smart" setting:
 *
 *     0  사용 안함    'off'
 *     2  10분         '10 min'
 *     3  30분         '30 min'
 *     4  60분         '60 min'
 *   253  스마트 건조  'smart'
 *
 * 1 was never offered by the app and is deliberately absent: an unlisted raw value reads
 * back as undefined and is discarded rather than shown as a wrong duration.
 */
const AUTO_DRY: Array<[number, string]> = [
    [0, 'off'],
    [2, '10 min'],
    [3, '30 min'],
    [4, '60 min'],
    [253, 'smart'],
]

/* Panel humidity display, TLV 0x337 - written over the private channel, see the select. */
const HUMIDITY_DISPLAY = ['while running', 'always']
/*
 * The private command behind it, measured on this appliance (2026-07-31): the app sends
 * cmd 0x0c, cmd_sub 0x01, with a 4-byte big-endian payload of 0 or 1, the appliance ACKs
 * (0x87/0xfd/0x10 carrying 0xfe 0x0c), and only then reports the new 0x337 in a state frame.
 * PAC_910604_WW documents the identical command from its own capture.
 */
const HUMIDITY_DISPLAY_PRIV_CMD = 0x0c
const HUMIDITY_DISPLAY_PRIV_SUB = 0x01

/*
 * The water tank's light, swept by the owner one step at a time (2026-07-31). Three separate
 * tags, all three of which this profile previously carried in its "constant, unlabelled" list:
 *
 *   0x21e  on/off        0 / 1
 *   0x3e0  colour        0..7, in the order the app lists them
 *   0x185  brightness    RAW = 100 + percent: 120, 140, 160, 180, 200 for 20/40/60/80/100 %
 *
 * The colour names are the app's own (화이트 / 마린블루 / 론그린 / 셀먼핑크 / 라벤더 / 스카이 /
 * 썬라이트 / 마젠타핑크). 0 = white is not from a write - the appliance was already reporting
 * 0x3e0 = 0 while the light showed white before the sweep touched the colour at all.
 *
 * Published as an HA light with the colours as its effect list, which is the honest shape:
 * these are eight named presets, not an RGB space, and an RGB entity would accept colours the
 * appliance cannot produce.
 */
const TANK_LIGHT_COLOURS: Array<{ name: string; rgb: [number, number, number] }> = [
    { name: 'white', rgb: [255, 255, 255] },
    { name: 'marine blue', rgb: [154, 173, 251] } /* #9aadfb */,
    { name: 'lawn green', rgb: [215, 246, 142] } /* #d7f68e */,
    { name: 'salmon pink', rgb: [255, 171, 171] } /* #ffabab */,
    { name: 'lavender', rgb: [213, 185, 255] } /* #d5b9ff */,
    { name: 'sky', rgb: [189, 238, 246] } /* #bdeef6 */,
    { name: 'sunlight', rgb: [251, 240, 144] } /* #fbf090 */,
    { name: 'magenta pink', rgb: [255, 189, 246] } /* #ffbdf6 */,
]

/*
 * THE RGB TRIPLES DO NOT COME OFF THE WIRE. The appliance sends a colour INDEX and nothing
 * else. Seven of the eight are the hex codes the owner read out of the LG app on 2026-07-31,
 * so they are what the app paints, not a guess; white is the one they did not quote and is
 * left at plain #ffffff. They exist because the owner asked for the colour to be visible in
 * HA rather than only as a word.
 *
 * Note how pale they all are - #9aadfb for "marine blue", #ffbdf6 for "magenta pink". An
 * earlier version of this table guessed at saturated versions of the same names and was
 * wrong about every one of them. Colour names are not colours.
 *
 * Consequence, and it is a real one: HA lets the user pick any colour, and a write is snapped
 * to whichever of these eight is nearest. The eight names stay available as the effect list,
 * which is the exact control; the RGB is the friendly one.
 */
const TANK_LIGHT_COLOUR_NAMES = TANK_LIGHT_COLOURS.map((c) => c.name)

/* HA brightness is published on a 1..100 scale; the appliance stores it offset by this. */
const TANK_LIGHT_BRIGHTNESS_OFFSET = 100
/*
 * The app moves brightness in 20 % steps and that is all the appliance was ever seen holding
 * (120, 140, 160, 180, 200). HA's MQTT light has no step of its own, so a write is snapped
 * here instead; 0 is not a brightness the appliance has, so it is taken as "switch the light
 * off", which is what the owner asked for.
 */
const TANK_LIGHT_BRIGHTNESS_STEP = 20

/*
 * How long a write waits for company before it goes out, in ms.
 *
 * HA's MQTT light publishes a light command as an ON plus its attributes - separate topics,
 * separate writes, arriving inside the same tenth of a second - and this appliance chimes at
 * every frame it accepts. Six light actions in one capture produced twelve frames and the
 * owner heard "띵디딩" where the LG app chimes once.
 *
 * MEASURED FIRST, then implemented: a single frame carrying 0x3e0 and 0x185 together was
 * injected into the live appliance and answered with ONE ack and ONE state frame carrying
 * both changes. So the burst is collected and sent as one frame. Anything arriving later than
 * this window is simply the next frame.
 */
const WRITE_COALESCE_MS = 150

/*
 * 집중건조 (focused dry, 0x1f9 = 20) runs the appliance its own way: while it is selected the
 * app offers no fan speed, no airflow aim and no target humidity (owner, 2026-07-31).
 *
 * THE APPLIANCE AGREES, and that is measured rather than inferred. A fan write injected while
 * this mode was on (0x1fa = 2) was ACKed and then ignored - no echo, and a values query 20 s
 * later still read 6. In the same window an HA-originated 0x253 = 45 met exactly the same
 * fate, and the owner confirms the app will not let them move it either. So on this appliance
 * an ACK is not acceptance; the ECHO is. (Mode 22 behaves the same way - see above.)
 *
 * The airflow aim is the one of the three never tested with a write. It is treated like the
 * other two because the app hides it in the same mode, which is the same "what can the user
 * select" standard that settled PAC_910604_WW's fan mask.
 *
 * Fan and airflow are separate entities, so they publish their own availability topic and go
 * unavailable in HA while this mode is on - the app's own greying-out, before the click
 * rather than after. Target humidity cannot: it is an attribute of the humidifier entity, and
 * making that unavailable would take power and mode with it. It refuses the write instead and
 * republishes the appliance's value, which is how RAC_056905_WW's mode-dependent switches
 * behave.
 */
const MODE_LOCKS_CONTROLS = 20
const MODE_DEPENDENT_ENTITIES = ['fanspeed', 'airflow']

/*
 * Target humidity limits, from the capability reply: 0x2e5 = 30 and 0x2e6 = 70. This is the
 * same shape as the AC profiles' 0x2e1 / 0x2e2 setpoint range, where the declared range
 * matched the remote exactly, so the appliance's own word is taken here too.
 *
 * ONLY 50 AND 55 WERE EXERCISED on the appliance (one step down, one step up, both echoed),
 * so the ends are the appliance's declaration and not a measurement. Both observed values
 * are multiples of 5 and the caps reply also carries 0x2f6 = 5, which looks like the step -
 * but HA's MQTT humidifier has no step for target humidity, and nothing here rounds a write.
 * An unsupported value can only cost one echo: whatever the appliance does with it, its next
 * state frame publishes the truth.
 */
const HUMIDITY_MIN = 30
const HUMIDITY_MAX = 70

type SwitchOptions = {
    /* raw TLV value written for 'ON' (default 1) */
    onValue?: number
    /* raw TLV value written for 'OFF' (default 0) */
    offValue?: number
    entityCategory?: string
}

type SelectOptions = {
    entityCategory?: string
    /*
     * Runs instead of the default TLV write when it returns false - which is how the one
     * setting that is written over the private channel is handled. See the humidity display.
     */
    writeCallback?: FieldDefinition['write_callback']
}

/*
 * HA files an entity by its entity_category: 'config' under "Configuration", 'diagnostic'
 * under "Diagnostic", and NO KEY AT ALL under "Controls". Spreadable so that "the caller
 * asked for Controls" and "the caller said nothing" stay distinguishable - copied from
 * PAC_910604_WW, where the same reasoning is written out at length.
 */
function entityCategoryOf(options: { entityCategory?: string }): { entity_category?: string } {
    if (!('entityCategory' in options)) return { entity_category: 'config' }
    if (options.entityCategory === undefined) return {}
    return { entity_category: options.entityCategory }
}

export default class Device extends TLVDevice {
    readonly deviceConfig: DehumDiscovery

    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq)

        /*
         * The whole configuration is built up front, as in PAC_910604_WW: nothing here is
         * gated on capability bits, so every entity exists from the first connect even
         * though the capability reply arrives later.
         */
        const config: DehumDiscovery = allowExtendedType({
            ...HADevice.config(meta, { name: 'LG Dehumidifier' }),
            components: {
                humidifier: {
                    platform: 'humidifier',
                    unique_id: '$deviceid-humidifier',
                    name: null,
                    device_class: 'dehumidifier',
                    min_humidity: HUMIDITY_MIN,
                    max_humidity: HUMIDITY_MAX,
                    modes: MODES.map(([, label]) => label),
                } satisfies HumidifierComponent,
            },
        })
        this.deviceConfig = config

        /*
         * Power, TLV 0x1f7. A BARE write is correct here and no write_attach is needed - the
         * app was captured sending 0x1f7 = 0 and 0x1f7 = 1 on their own, with nothing
         * attached, and the appliance obeyed both. (RAC_056905_WW and PAC_910604_WW attach
         * mode / fan / setpoint to a power-on because a bare 0x1f7 was never observed on
         * those appliances; that reason does not apply to this one.)
         *
         * Switching the appliance OFF while auto-dry is armed starts the auto-dry run rather
         * than stopping the appliance dead - see the remaining-minutes sensor below.
         */
        this.addField(config, {
            id: 0x1f7,
            name: '',
            comp: 'humidifier',
            write_xform: (val) => (val === 'ON' ? 1 : 0),
            read_xform: (raw) => (raw ? 'ON' : 'OFF'),
        })

        this.addField(config, {
            id: 0x1f9,
            name: 'mode',
            comp: 'humidifier',
            ...mapXforms(MODES),
            read_callback: (val) => {
                /* the fan controls follow the mode - see MODE_LOCKS_CONTROLS */
                this.updateModeAvailability()
                return true
            },
        })

        /*
         * Target humidity, TLV 0x253, a plain percentage - written 50 and 55 by the app and
         * echoed unchanged, so no scaling.
         */
        this.addField(config, {
            id: 0x253,
            name: 'target_humidity',
            comp: 'humidifier',
            /* TLVDevice.setProperty() drops a write whose field has no write_xform, so even a
             * pass-through needs one; MQTT hands the value over as a string. */
            write_xform: (val) => Number(val),
            write_callback: () => {
                if (this.raw_clip_state[0x1f9] !== MODE_LOCKS_CONTROLS) return true
                /*
                 * The appliance would ACK this and do nothing - measured. Republish what it
                 * actually holds so HA's slider snaps back instead of showing a value that
                 * never took.
                 */
                this.processKeyValue(0x253, this.raw_clip_state[0x253])
                return false
            },
        })

        /*
         * Indoor relative humidity, TLV 0x336: a plain integer percentage, no scaling. The
         * owner read 63 % off the app while the frames carried 0x336 = 63. It drifts by one
         * over tens of seconds (60..63 across the session), which is a room measurement
         * behaving like one. PAC_910604_WW reads the same tag the same way.
         */
        this.addField(config, {
            id: 0x336,
            name: 'current_humidity',
            comp: 'humidifier',
            state_topic: 'topic',
            writable: false,
        })

        /*
         * ...and again as a sensor of its own, sharing the humidifier's topic rather than
         * registering 0x336 twice: TLVDevice.fields_by_id holds one definition per tag, so a
         * second addField() for the same tag would silently replace the first. A humidity
         * reading is worth having as an entity that can be graphed and used in automations,
         * not only as an attribute of the humidifier.
         */
        config.components['humidity'] = {
            platform: 'sensor',
            unique_id: '$deviceid-humidity',
            name: 'Humidity',
            state_topic: '$this/humidifier-current_humidity',
            device_class: 'humidity',
            unit_of_measurement: '%',
            state_class: 'measurement',
            suggested_display_precision: 0,
        } as ComponentInfo

        this.addMappedSelectField(config, 0x1fa, 'fanspeed', 'Fan speed', 'mdi:fan', FAN_SPEEDS, {
            entityCategory: undefined,
        })

        this.addSelectField(config, 0x189, 'airflow', 'Airflow', 'mdi:air-conditioner', AIRFLOW, {
            entityCategory: undefined,
        })

        /*
         * Filed under Diagnostic at the owner's request (2026-07-31). It is a setting, so
         * 'config' would be the conventional category; 'diagnostic' is what was asked for and
         * the only thing it changes is which box of the HA device page it sits in.
         */
        this.addMappedSelectField(config, 0x20e, 'autodry', 'Auto dry', 'mdi:hair-dryer', AUTO_DRY, {
            entityCategory: 'diagnostic',
        })

        this.addSwitchField(config, 0x2a2, 'uvnano', 'UVnano', 'mdi:bacteria')
        this.addSwitchField(config, 0x3a9, 'childlock', 'Child lock', 'mdi:lock')

        /*
         * Both of these are INVERTED, and both were measured that way on this appliance: the
         * owner turned 제품 버튼음 (beep) off and the app wrote 0x3a0 = 1, then on and it
         * wrote 0. Same for 제품 상태 표시부 (the panel light) on 0x21f. PAC_910604_WW
         * measured the identical polarity on both tags independently, which is reassuring but
         * is not why they are written this way here.
         */
        this.addSwitchField(config, 0x3a0, 'beep', 'Beep Sound', 'mdi:volume-high', { onValue: 0, offValue: 1 })
        this.addSwitchField(config, 0x21f, 'display', 'Display Light', 'mdi:led-on', { onValue: 0, offValue: 1 })

        /*
         * Turn-off reservation, TLV 0x21b, stored in MINUTES. The owner set 1 through 8 hours
         * in the app and the writes were 60, 120, 180, 240, 300, 360, 420 and 480.
         *
         * The value read back is NOT the value written: the appliance echoed 59, 119, 179,
         * 239, 299, 359, 419 and 479, i.e. it starts counting down immediately. So this
         * number decreases on its own while the reservation runs, and the read transform
         * rounds UP - 479 minutes left is still more than 7.75 h, so it shows 8 h. Switching
         * the appliance off cleared it to 0 in the same state frame that carried 0x1f7 = 0.
         *
         * `max` is 8 because 8 h is the longest the owner was offered and the highest value
         * ever seen on the wire. If this appliance's app allows more, raise it - the ceiling
         * is a measurement of the sweep, not a declaration by the appliance.
         *
         * RAC_056905_WW reads 0x21b as its turn-off timer too. 0x21c - RAC's turn-ON timer -
         * stayed 0 here throughout, so no turn-on entity is published: the appliance was
         * never seen using it, and a reservation set while running can only mean off.
         */
        this.addTimerField(config, 0x21b, 'offtimer', 'Turn-off reservation', 'mdi:timer-stop', 8)

        /*
         * Auto-dry remaining minutes, TLV 0x225. Confirmed twice over: the owner reported the
         * appliance displaying 50분 when auto-dry started, and 0x225 = 50 appears in the same
         * state frame as the power-off that started it, then counts down one per minute
         * (50, 49, ... 35 observed live). PAC_910604_WW publishes the same tag as its AI-dry
         * remaining, also in minutes.
         */
        this.addSensorField(
            config,
            0x225,
            'autodry_remaining',
            'Auto dry remaining',
            'mdi:timer-sand',
            {
                device_class: 'duration',
                unit_of_measurement: 'min',
                state_class: 'measurement',
            },
            undefined,
            (val) => {
                this.publishAutoDryRunning(Number(val))
                return true
            },
        )

        /*
         * "Is auto-dry running right now?", derived from the remaining minutes rather than
         * from a flag of its own, because no flag was found: 0x20e is the SETTING (off / 10 /
         * 30 / 60 min / smart), not a run state, and it reads 253 whether the appliance is
         * drying or not.
         *
         * 0x225 > 0 is the whole signal, and every observation agrees with it: it was 0
         * throughout normal running, appeared as 50 in the very state frame that carried the
         * power-off which started the run, then counted down 50, 49, ... 0. RAC_056905_WW
         * publishes 0x20e as its auto-dry binary sensor, which would be wrong here - on this
         * appliance that tag never returns to 0 on its own.
         *
         * Note this is normally ON while the appliance reads OFF: auto-dry is what the machine
         * does AFTER it is switched off.
         */
        config.components['autodry_running'] = {
            platform: 'binary_sensor',
            unique_id: '$deviceid-autodry_running',
            name: 'Auto dry running',
            icon: 'mdi:hair-dryer',
            device_class: 'running',
            state_topic: '$this/autodry_running',
            entity_category: 'diagnostic',
        } as ComponentInfo

        /*
         * Stopping a run in progress is a write of 0x225 = 0 - the remaining-minutes tag set
         * to zero. Captured from the app on 2026-07-31: the write, an ACK, and then the
         * appliance's own 0x225: 29 -> 0. PAC_910604_WW cancels its AI dry with the identical
         * command, arrived at from its own capture.
         *
         * A BUTTON, not a switch, because there is no way to start a cycle on demand: the
         * appliance begins one by itself when it is switched off with 0x20e set, and the owner
         * confirms the app offers no restart. A switch would have an ON that goes nowhere.
         * The auto-dry SETTING (0x20e) is untouched by this - it is the standing preference
         * for the next power-off, and only the run stops.
         *
         * Registered straight into fields_by_ha because addField() would take fields_by_id
         * [0x225] away from the remaining-minutes sensor. The callback sends the frame and
         * returns false so nothing stamps a 0 into the local state - the appliance's own
         * reply is what moves the sensor.
         */
        config.components['autodry_cancel'] = {
            platform: 'button',
            unique_id: '$deviceid-autodry_cancel',
            command_topic: '$this/autodry_cancel/set',
            name: 'Stop auto dry',
            icon: 'mdi:hair-dryer-outline',
            entity_category: 'diagnostic',
        } as ComponentInfo
        this.fields_by_ha['autodry_cancel'] = {
            name: '',
            comp: '',
            write_xform: (val) => (val === 'PRESS' ? 0 : null),
            write_callback: () => {
                this.send([1, 1, 2, 1, 1], [{ t: 0x225, v: 0 }])
                return false
            },
        }

        /* Error code, 0 throughout - as in RAC_056905_WW / PAC_910604_WW. */
        this.addSensorField(config, 0x221, 'error', 'Error code', 'mdi:alert')

        /*
         * Temperature, TLV 0x1fd. SCALE INHERITED, NOT MEASURED HERE - stated plainly rather
         * than left looking like a reading. The AC profiles read this tag as degrees x 2 and
         * that is verified on them; on this appliance THE APP SHOWS NO TEMPERATURE AT ALL, so
         * there is no display to check the wire against. What is known: the raw value moved
         * 56, 54, 52, 50 over half an hour, which is 28.0, 27.0, 26.0, 25.0 C under the
         * inherited scale, and the owner judged 27-28 C plausible for the room at the time.
         *
         * Published without an entity_category at the owner's request (2026-07-31), so HA
         * files it under "Sensors" with the humidity rather than under "Diagnostic": it is a
         * room reading, whatever remains unsettled about its scale. Nothing in this profile
         * depends on it, and one reading against a room thermometer would settle that.
         */
        this.addSensorField(
            config,
            0x1fd,
            'temperature',
            'Temperature',
            undefined,
            {
                device_class: 'temperature',
                unit_of_measurement: '°C',
                state_class: 'measurement',
                suggested_display_precision: 1,
                /* a room measurement, not diagnostics - override addSensorField's default */
                entity_category: undefined,
            },
            (raw) => raw / 2,
        )

        /*
         * Whether the appliance's own panel shows the humidity all the time or only while
         * running (습도 센서: 항상 표시 / 운전중에만 표시), TLV 0x337.
         *
         * WRITABLE, but NOT with a TLV write: this tag has no TLV write anywhere in any
         * capture. The app changes it over the private command channel, and the owner
         * reproduced both directions while recording so the exact frames are on file - see
         * HUMIDITY_DISPLAY_PRIV_CMD. The write callback below therefore sends the private
         * command and returns false, which stops TLVDevice from also sending a TLV write that
         * was never observed working. The appliance's own 0x337 state frame is what updates
         * the entity, so nothing here fakes the new value either.
         */
        this.addSelectField(config, 0x337, 'humidity_display', 'Panel humidity display', 'mdi:eye', HUMIDITY_DISPLAY, {
            entityCategory: 'diagnostic',
            writeCallback: (val) => {
                this.sendPrivWrite(HUMIDITY_DISPLAY_PRIV_CMD, HUMIDITY_DISPLAY_PRIV_SUB, Buffer.from([0, 0, 0, val]))
                /* false: the private command IS the write - do not follow it with a TLV one */
                return false
            },
        })

        /*
         * The water tank's light - on/off, brightness and eight named colours. See
         * TANK_LIGHT_COLOURS for how each value was established.
         *
         * entity_category 'config' at the owner's request: it is a preference about the
         * appliance rather than an everyday control.
         */
        config.components['tanklight'] = {
            platform: 'light',
            unique_id: '$deviceid-tanklight',
            name: 'Tank light',
            icon: 'mdi:lightbulb',
            entity_category: 'config',
            brightness_scale: 100,
            effect_list: TANK_LIGHT_COLOUR_NAMES,
        } as ComponentInfo

        /*
         * The light's own on/off, and the reason the appliance beeps twice for one HA action.
         *
         * MEASURED (2026-07-31): every light command from HA arrives as TWO MQTT publishes -
         * the attribute AND an ON - because that is how HA's MQTT light works. Six light
         * actions in one capture produced twelve write frames, six of them 0x21e = 1 sent to
         * an appliance that was already on, each drawing its own ACK and its own beep. The LG
         * app sends one frame and the appliance beeps once.
         *
         * So a write that would not change anything is dropped. This is narrow on purpose: it
         * applies to this tag, where a redundant write is HA's own doing rather than the
         * owner's, and raw_clip_state[0x21e] is the appliance's own last word rather than a
         * guess. Turning the light on when it really is off still sends.
         *
         * It does not merge the two frames into one multi-TLV write, which would be the
         * complete answer: that shape is what RAC_056905_WW's write_attach produces, but this
         * appliance has never been sent one and an untested frame shape is not a fix.
         */
        this.addField(config, {
            id: 0x21e,
            name: '',
            comp: 'tanklight',
            write_xform: (val) => (val === 'ON' ? 1 : 0),
            read_xform: (raw) => (raw ? 'ON' : 'OFF'),
            write_callback: (val) => this.raw_clip_state[0x21e] !== val,
        })

        this.addField(config, {
            id: 0x185,
            name: 'brightness',
            comp: 'tanklight',
            write_xform: (val) => {
                const percent = Math.round(Number(val) / TANK_LIGHT_BRIGHTNESS_STEP) * TANK_LIGHT_BRIGHTNESS_STEP
                if (percent <= 0) {
                    /* 0 % is not a brightness this appliance has - switch the light off instead */
                    this.setTankLightPower(false)
                    return null
                }
                return Math.min(percent, 100) + TANK_LIGHT_BRIGHTNESS_OFFSET
            },
            /*
             * Only 120..200 in steps of 20 were ever seen, and the offset makes anything at or
             * below it meaningless as a percentage, so such a reading is discarded rather than
             * published as 0 %. Nothing rounds a write to the app's 20 % steps: if the
             * appliance refuses an in-between value its next state frame says so, and rounding
             * would hide that.
             */
            read_xform: (raw) => (raw > TANK_LIGHT_BRIGHTNESS_OFFSET ? raw - TANK_LIGHT_BRIGHTNESS_OFFSET : undefined),
        })

        this.addField(config, {
            id: 0x3e0,
            name: 'effect',
            comp: 'tanklight',
            read_xform: (raw) => TANK_LIGHT_COLOURS[raw]?.name,
            write_xform: (val) => {
                const index = TANK_LIGHT_COLOUR_NAMES.indexOf(val)
                return index < 0 ? null : index
            },
            read_callback: (label) => {
                /* keep the RGB view in step with the name - see TANK_LIGHT_COLOURS */
                const colour = TANK_LIGHT_COLOURS.find((c) => c.name === label)
                if (colour) this.HA.publishProperty(this.id, 'tanklight-rgb', colour.rgb.join(','))
                return true
            },
        })

        /*
         * The same colour again as RGB, so HA's colour picker shows it and can set it. No `id`:
         * 0x3e0 already belongs to the effect field above and TLVDevice keeps one definition
         * per tag, so this one carries no tag of its own and does its write by hand.
         */
        this.addField(config, {
            name: 'rgb',
            comp: 'tanklight',
            write_xform: (val) => nearestTankLightColour(val),
            write_callback: (index) => {
                this.raw_clip_state[0x3e0] = index
                this.send([1, 1, 2, 1, 1], [{ t: 0x3e0, v: index }])
                return false
            },
        })

        /*
         * STILL NOT HERE: whether the tank is full or removed. Pulling the tank out of a
         * running appliance for four minutes produced no state frame at all, no sound and no
         * panel indication (2026-07-31, dehum-watertank-20260730.jsonl), so there is nothing
         * to map yet. The next thing to try is a tank filled to its line, which trips the
         * float switch the appliance does react to.
         */

        /*
         * The two mode-dependent entities get their own availability topic ON TOP OF the two
         * device-wide ones. A component's `availability` REPLACES the device-level list rather
         * than adding to it, so both device topics have to be repeated here or these two would
         * stop following the device's own online/offline.
         */
        for (const name of MODE_DEPENDENT_ENTITIES) {
            const comp = config.components[name] as unknown as Record<string, unknown>
            comp.availability = [
                { topic: '$this/availability' },
                { topic: '$rethink/availability' },
                { topic: `$this/${name}-availability` },
            ]
            comp.availability_mode = 'all'
        }

        this.setConfig(config)

        /*
         * Publish the initial availability AFTER setConfig, and unconditionally: an MQTT
         * entity whose availability topic has never been published reads as unavailable, so
         * staying silent until the first mode frame would grey both entities out on every
         * connect. No mode is known yet at this point, which updateModeAvailability() treats
         * as available - the honest default, since the appliance has not said otherwise.
         */
        this.updateModeAvailability()
    }

    /*
     * Grey out the fan controls in the modes that do not offer them - see
     * MODE_LOCKS_CONTROLS. Called from the mode field's read callback and once at startup.
     */
    updateModeAvailability() {
        const mode = this.raw_clip_state[0x1f9]
        const state = mode === MODE_LOCKS_CONTROLS ? 'offline' : 'online'
        for (const name of MODE_DEPENDENT_ENTITIES) {
            this.HA.publishProperty(this.id, `${name}-availability`, state)
        }
    }

    /* "Auto-dry is running", derived from the remaining minutes - see the binary sensor. */
    publishAutoDryRunning(remainingMinutes: number) {
        this.HA.publishProperty(this.id, 'autodry_running', remainingMinutes > 0 ? 'ON' : 'OFF')
    }

    /*
     * Frame markers seen from this appliance at buf[6]:
     *   0xa7  every state frame (buf[7] = 0x02, buf[8] = 0x04) AND the capability reply
     *         (buf[8] = 0x01) - 63 of them in the session
     *   0x87  the 13-byte empty-payload acknowledgement that follows each write
     *         (buf[7] = 0x01, buf[8] = 0x10), and the 190-byte buf[7] = 0xfd frames
     *   0xa8  the 97-byte telemetry family - NOT TLV, see the class comment
     *
     * The branch below is the base class' state-frame branch with the marker widened to
     * accept 0xa7, so it is a strict superset; the delegation at the end therefore only ever
     * hands the base class frames it would have ignored anyway, and nothing is processed
     * twice. 0x87 is still accepted, so a firmware that behaves like every other model keeps
     * working.
     */
    processData(buf: Buffer) {
        if (
            buf[2] === 0x04 &&
            buf[3] === 0x00 &&
            buf[4] === 0x00 &&
            buf[5] === 0x00 &&
            (buf[6] === 0x87 || buf[6] === 0xa7) &&
            buf[7] === 0x02 &&
            (buf[8] === 0x01 || buf[8] === 0x04) &&
            buf[10] === buf.length - 13
        ) {
            this.processTLV(TLV.parse(buf.subarray(11, buf.length - 2)))
            return
        }

        super.processData(buf)
    }

    /*
     * Measured, not assumed. queryCaps()'s frame (TLV 0x1f5 = 1) was injected into the live
     * appliance before this profile existed and it answered with a 134-byte, 41-TLV reply
     * marked 0xa7 with buf[8] = 0x01, carrying 0x2da = 3518. So keying on 0x2da matches
     * RAC_056905_WW, POT_056905_WW and PAC_910604_WW and is right for this model too.
     *
     * This predicate failing is not a cosmetic problem: TLVDevice's constructor re-sends the
     * capability query every 15 s until it returns true, and only then starts the values
     * query. Hence the live probe.
     *
     * The same reply is where MODES, FAN_SPEEDS, HUMIDITY_MIN and HUMIDITY_MAX get their
     * independent confirmation - see those constants.
     */
    isCapsResponse(tlvArray: TLV.TLV[]) {
        /* eeprom checksum */
        return tlvArray.some(({ t }) => t === 0x2da)
    }

    /*
     * Also measured: query()'s frame (TLV 0x1f5 = 2) was injected and the appliance answered
     * with its 125-byte, 47-TLV comprehensive dump, 0x1f7 among the tags. The capability
     * reply does NOT carry 0x1f7, so the two predicates cannot be confused for one another.
     */
    isValuesResponse(tlvArray: TLV.TLV[]) {
        return tlvArray.length >= 10 && tlvArray.some(({ t }) => t === 0x1f7)
    }

    /*
     * No setMaskingInfo() call, unlike PAC_910604_WW. This appliance already reports every
     * tag this profile maps as an asynchronous single-attribute state frame - that is how all
     * of them were labelled, over a 25-minute recording that includes long idle stretches -
     * so the masking write would buy nothing, and it is a write to the appliance that was
     * never observed being made to THIS model. TLVDevice.start()'s 15-minute values query
     * stays as the backstop for anything that does not notify.
     */

    /* --- helpers ---------------------------------------------------------------------
     * Deliberately re-implemented rather than imported: the equivalents in RAC_056905_WW and
     * PAC_910604_WW are private methods of those profiles, and the three share no base class
     * below TLVDevice.
     */

    addSwitchField(
        config: DeviceDiscovery,
        id: number,
        name: string,
        desc: string,
        icon: string,
        options: SwitchOptions = {},
    ) {
        const onValue = options.onValue ?? 1
        const offValue = options.offValue ?? 0

        config['components'][name] = {
            platform: 'switch',
            unique_id: '$deviceid-' + name,
            name: desc,
            icon: icon,
            ...entityCategoryOf(options),
        } as ComponentInfo

        this.addField(config, {
            id: id,
            name: '',
            comp: name,
            write_xform: (val) => (val === 'ON' ? onValue : offValue),
            read_xform: (raw) => (raw === onValue ? 'ON' : 'OFF'),
        })
    }

    /* Contiguous raw values: `options[raw - rawBase]`. A raw outside the list is discarded. */
    addSelectField(
        config: DeviceDiscovery,
        id: number,
        name: string,
        desc: string,
        icon: string,
        options: string[],
        selectOptions: SelectOptions = {},
        rawBase: number = 0,
    ) {
        config['components'][name] = {
            platform: 'select',
            unique_id: '$deviceid-' + name,
            name: desc,
            icon: icon,
            options: options,
            ...entityCategoryOf(selectOptions),
        } as ComponentInfo

        this.addField(config, {
            id: id,
            name: '',
            comp: name,
            read_xform: (raw) => options[raw - rawBase],
            write_xform: (val) => {
                const index = options.indexOf(val)
                /* null cancels the write rather than sending a bogus value */
                if (index < 0) return null
                return index + rawBase
            },
            write_callback: selectOptions.writeCallback,
        })
    }

    /*
     * A private-channel write, for the one setting that has no TLV write.
     *
     * TLVDevice.sendPrivCommand() is not used because its first two bytes are hardcoded to
     * 00 ff, and that is not what the app sends for a WRITE. Measured on this appliance, all
     * four legs of one setting change:
     *
     *   01 02 ... 65 fd 01 | 0005 | 0c 00000000    the write        <- what this method sends
     *   02 02 ... 87 fd 10 | 0005 | fe 0c 000000   the ACK
     *   00 ff ... 65 fd 02 | 0005 | 0c 00000000    a read-back the app then does
     *   02 ff ... 65 fd 03 | 0005 | 0c 00000000    its answer
     *
     * So 00 ff is the prefix of the READ leg. Sending a write under it was never observed and
     * is not assumed to work.
     */
    /* TLVs waiting to go out as one frame - see WRITE_COALESCE_MS. */
    pendingWrite: TLV.TLV[] = []
    writeFlushTimer: ReturnType<typeof setTimeout> | undefined

    /*
     * Only WRITES are collected: the header the base class uses for its capability and values
     * queries is different, and those must not be delayed or merged into anything. A tag
     * written twice inside one window keeps the last value, which is what the sender meant.
     */
    send(header: number[], tlv: TLV.TLV[]) {
        const isWrite = header[2] === 2 && header[3] === 1 && header[4] === 1
        if (!isWrite) return super.send(header, tlv)

        for (const entry of tlv) {
            const existing = this.pendingWrite.findIndex((p) => p.t === entry.t)
            if (existing >= 0) this.pendingWrite[existing] = entry
            else this.pendingWrite.push(entry)
        }

        if (this.writeFlushTimer !== undefined) return
        this.writeFlushTimer = setTimeout(() => {
            this.writeFlushTimer = undefined
            const batch = this.pendingWrite
            this.pendingWrite = []
            if (batch.length) super.send([1, 1, 2, 1, 1], batch)
        }, WRITE_COALESCE_MS)
    }

    drop() {
        if (this.writeFlushTimer !== undefined) {
            clearTimeout(this.writeFlushTimer)
            this.writeFlushTimer = undefined
        }
        super.drop()
    }

    /* Used when a brightness of 0 arrives: HA means "off", and the appliance has a tag for it. */
    setTankLightPower(on: boolean) {
        this.raw_clip_state[0x21e] = on ? 1 : 0
        this.send([1, 1, 2, 1, 1], [{ t: 0x21e, v: on ? 1 : 0 }])
    }

    sendPrivWrite(cmd: number, cmd_sub: number, data: Buffer) {
        const length = data.length + 1
        let buf = Buffer.concat([
            Buffer.from([0x01, 0x02, 0x04, 0x00, 0x00, 0x00, 0x65, 0xfd, cmd_sub, length >> 8, length & 0xff, cmd]),
            data,
        ])
        const crc = crc16(buf.subarray(2))
        buf = Buffer.concat([buf, Buffer.from([crc >> 8, crc & 0xff])])
        this.thinq.send_packet(buf)
    }

    /*
     * Non-contiguous raw values, which is the normal case on this appliance: modes are
     * 19/20/85/86, fan speeds 2/4/6/7/8, auto-dry 0/2/3/4/253. An offset into a list cannot
     * express any of those without inventing entries for values the appliance never sends.
     */
    addMappedSelectField(
        config: DeviceDiscovery,
        id: number,
        name: string,
        desc: string,
        icon: string,
        map: Array<[number, string]>,
        selectOptions: SelectOptions = {},
    ) {
        config['components'][name] = {
            platform: 'select',
            unique_id: '$deviceid-' + name,
            name: desc,
            icon: icon,
            options: map.map(([, label]) => label),
            ...entityCategoryOf(selectOptions),
        } as ComponentInfo

        this.addField(config, { id: id, name: '', comp: name, ...mapXforms(map) })
    }

    /*
     * A countdown reservation, published as an HA number in hours while the appliance stores
     * minutes. Same shape as RAC_056905_WW's and PAC_910604_WW's.
     */
    addTimerField(config: DeviceDiscovery, id: number, name: string, desc: string, icon: string, max: number) {
        config['components'][name] = {
            platform: 'number',
            unique_id: '$deviceid-' + name,
            name: desc,
            icon: icon,
            device_class: 'duration',
            unit_of_measurement: 'h',
            min: 0,
            max: max,
            /* the app moves this in whole hours - 1 .. 8 - and so does the entity */
            step: 1,
            mode: 'slider',
        } as ComponentInfo

        this.addField(config, {
            id: id,
            name: '',
            comp: name,
            /* round UP: 479 minutes left is still 8 hours' worth of reservation, not 7 */
            read_xform: (raw) => Math.ceil(raw / 60),
            write_xform: (val) => Math.round(Number(val) * 60),
        })
    }

    addSensorField(
        config: DeviceDiscovery,
        id: number,
        name: string,
        desc: string,
        icon?: string,
        extra?: Record<string, unknown>,
        read_xform?: FieldDefinition['read_xform'],
        /* must return true, or this sensor stops publishing - see FieldDefinition */
        read_callback?: FieldDefinition['read_callback'],
    ) {
        config['components'][name] = {
            icon: icon ?? undefined,
            platform: 'sensor',
            unique_id: '$deviceid-' + name,
            name: desc,
            entity_category: 'diagnostic',
            ...extra,
        } as ComponentInfo

        this.addField(config, {
            id: id,
            name: '',
            comp: name,
            writable: false,
            read_xform: read_xform,
            read_callback: read_callback,
        })
    }
}

/*
 * Read/write transforms for a (raw value, label) map. An unlisted raw returns undefined, which
 * TLVDevice.processKeyValue() discards - so an unknown value publishes nothing instead of
 * being forced onto the nearest label. An unlisted label returns null, which cancels the
 * write.
 */
/*
 * "r,g,b" -> the index of the nearest of the eight presets, by plain squared distance in RGB.
 * The appliance has no other colours, so a request for one it cannot make has to become the
 * closest one it can rather than be dropped: HA's colour wheel would otherwise look broken.
 */
function nearestTankLightColour(value: string): number | null {
    const parts = value.split(',').map((n) => Number(n))
    if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return null

    let best = 0
    let bestDistance = Infinity
    TANK_LIGHT_COLOURS.forEach((colour, index) => {
        const distance = colour.rgb.reduce((sum, c, i) => sum + (c - parts[i]) ** 2, 0)
        if (distance < bestDistance) {
            bestDistance = distance
            best = index
        }
    })
    return best
}

function mapXforms(map: Array<[number, string]>): Pick<FieldDefinition, 'read_xform' | 'write_xform'> {
    return {
        read_xform: (raw) => map.find(([value]) => value === raw)?.[1],
        write_xform: (val) => map.find(([, label]) => label === val)?.[0] ?? null,
    }
}
