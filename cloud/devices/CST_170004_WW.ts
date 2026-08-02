import ACDevice, { type SwingAxis, type WireLevels } from './ac_common'
import { type ClimateComponent, type DeviceDiscovery } from '../homeassistant'
import { allowExtendedType } from '@/util/casting'
import { applyKoreanNames } from './korean'

/*
 * LG wall-mounted / built-in IDU, ThinQ model CST_170004_WW, deviceType 401.
 *
 * Seven units on this site across three capacity tiers, which the Wi-Fi module MACs mirror
 * exactly: 1c3929xxxxxx (large), 2028bce5xxxx (medium), 2028bcdcxxxx (small). The LG cloud
 * reports an identical capability set for all seven — same hvac modes, same six fan steps,
 * same 16-30 degC range, supported_features 409 — so one driver covers the tier spread.
 *
 * Same DualCool TLV scheme as RAC / CST_570004, so the protocol handling comes from ac_common.
 *
 * UART header: this family emits async/query frames with header byte6 = 0xa7 rather than 0x87,
 * the same as the ceiling cassette, so it widens the accepted set through isHeaderByte6() below.
 *
 * HOW THE WIRE VALUES BELOW WERE ESTABLISHED
 * ------------------------------------------
 * Every enum was swept end to end on a live unit with bridge mode on, so each step had
 * three independent witnesses that had to agree: the value we asked HA to set, the tag the
 * appliance then reported, and what `lge_thinq` (LG's own decode of the same appliance) read
 * back. A value the appliance silently refuses shows up as "wire unchanged" — which is exactly
 * how three fan speeds stayed broken on the dehumidifier for a while.
 *
 *   mode  cool=0  dry=1  fan_only=2  auto=3         (all four confirmed both directions)
 *   fan   미약풍=1 약풍=2 중풍=4 강풍=6 파워풍=7 자동풍=8    (all six confirmed in cool mode)
 *   0x1fd / 0x1fe are half-degrees: wire 58 = 29.0 degC, wire 36 = 18.0 degC
 *   0x2b3 is watts one-for-one — wire 177 while the cloud reported 177 W
 *
 * That last one is why there is no powerReadXform() here. ac_common's default already passes
 * the raw value through, so nothing needs overriding; the point worth recording is the negative
 * one — RAC's max(5, raw - 60) correction must NOT be inherited, and it is not, because RAC
 * declares it on itself rather than in the base. Applying it here would read ~60 W low.
 *
 * The fan list is mode-dependent on the hardware: in 송풍 (fan_only) the unit rejects 파워풍
 * outright — LG's own cloud command for it was refused too — while all six work in 냉방. That is
 * the appliance's behaviour, not a mapping error, so all six are offered and the appliance is
 * left to refuse what it cannot do, exactly as it does for the LG app.
 */

/*
 * ON POLLING FOR INSTANTANEOUS POWER — measured, and deliberately not done
 * ------------------------------------------------------------------------
 * Live power is the main reason for running this appliance locally, and the obvious move is to
 * poll faster than ac_common's 28 s. It was tried and then removed, because the measurement says
 * it buys nothing.
 *
 * The appliance recomputes 0x2b3 on a fixed one-minute cycle and pushes the new value the moment
 * it has it. Sampling at 1 s for five minutes caught five changes, at 43.7 / 60.6 / 60.4 / 60.4 /
 * 60.1 s apart — and **all five arrived as unsolicited two-field pushes**, none as an answer to a
 * query. Polling at 1 s contributed exactly zero readings while publishing ~15 entity updates a
 * second, and would do so on every one of the seven units.
 *
 * The earlier conclusion that this appliance "never pushes power" came from a window in which the
 * unit sat at a steady 408 W: it does not repeat an unchanged value, which looked like silence.
 *
 * (A neighbouring RAC_056905_WW gets a full state frame roughly every 0.4 s. That unit reports ODU
 * telemetry — outdoor air and heat-exchanger temperatures at 0.01 degC, EEV opening — which really
 * does change that often, so its packets are frequent. This multi-split IDU reports none of that.
 * The difference is in what the two units measure, not in how either is being asked.)
 *
 * So ac_common's interval is left alone. It is the backstop for a dropped push, not the path the
 * data normally takes, and the appliance's own 60 s cycle is the ceiling either way.
 */

/*
 * Vertical vane position, 0x321. Positions 1-6 were each set and read back; the continuous-sweep
 * value 100 that other models accept is refused here — the unit coerced it straight back to 4 —
 * so it is not offered. Sweeping is a separate on/off flag on this model (0x205, below).
 */
const SWING_VERTICAL_STEPS_KR: WireLevels = [
    ['정지', 0],
    ['1단(위)', 1],
    ['2단', 2],
    ['3단', 3],
    ['4단', 4],
    ['5단', 5],
    ['6단(아래)', 6],
]

/*
 * The 회전 control: the two on/off rotation flags, 0x205 up-down and 0x206 left-right, over their
 * four combinations.
 *
 * They are genuinely two independent flags — all seven units report both, and a sweep across the
 * fleet caught them disagreeing in both directions (one unit at 0x205=0 / 0x206=1, another the
 * reverse) — but to the person using the appliance they are one setting, which is how the LG app
 * presents them: a single 바람 방향 screen with both switches on it.
 *
 * Publishing them as one climate `swing_mode` rather than two entities is what puts the control on
 * the card: `swing_mode` is the swing control HA renders for a climate entity. The obvious
 * alternative — HA's second attribute `swing_horizontal_mode` for the left-right half — was tried
 * first and is what prompted this: it is carried correctly all the way into the entity's
 * attributes, and it still never appeared anywhere the appliance is actually operated from.
 */
const SWING_ROTATIONS: { label: string; ud: number; lr: number }[] = [
    { label: '정지', ud: 0, lr: 0 },
    { label: '상하', ud: 1, lr: 0 },
    { label: '좌우', ud: 0, lr: 1 },
    { label: '자동', ud: 1, lr: 1 },
]

export default class Device extends ACDevice {
    readonly haDeviceName = 'LG 에어컨'

    /* This family emits its async/query TLV frames with UART header byte 6 = 0xa7 instead of 0x87. */
    isHeaderByte6(byte: number): boolean {
        return byte === 0x87 || byte === 0xa7
    }

    /*
     * Operation modes. HA fixes this vocabulary — hvac_mode has to be one of HA's own constants,
     * so unlike the fan list these cannot be Korean; HA localises them in the UI itself.
     * 0x2c1 reads 15 = 0b1111, i.e. modes {0,1,2,3} and no heat, matching a cooling-only ODU.
     */
    readonly modeLevels: WireLevels = [
        ['cool', 0],
        ['dry', 1],
        ['fan_only', 2],
        ['auto', 3],
    ]

    /*
     * Fan speeds. Labels are Korean because this model is sold in Korea and its panel, the LG app
     * and the cloud integration all use these names — matching them keeps one vocabulary across
     * the local and cloud paths instead of inventing a second. Same reasoning as DHUM_231006_WW.
     */
    readonly fanLevels: WireLevels = [
        ['자동풍', 8],
        ['미약풍', 1],
        ['약풍', 2],
        ['중풍', 4],
        ['강풍', 6],
        ['파워풍', 7],
    ]

    /*
     * Not narrowed by the 0x2c2 bitmap, for the same reason as CST_570004_WW: the cassette on file
     * reports 469 there - wire values 0, 2, 4, 6, 7 and 8 - which offers 0 where the list above has
     * 1, and letting the bitmap narrow it would silently drop 미약풍. All six steps above were
     * confirmed in both directions on a live unit in 냉방, so the driven list wins over an
     * unexplained disagreement about the slowest step.
     */
    fanCaps() {
        return undefined
    }

    /* Selecting a mode while off is ignored; the mode write has to carry 0x1f7=1. */
    readonly powerOnWithModeWrite = true

    /*
     * This unit accepts the on/off timer tags, acknowledges them and then does nothing with them,
     * and never reports them back — so the cloud loses the whole airState.reservation.* bundle the
     * LG app needs. Run the reservation here instead. See ACDevice.relayReservation.
     */
    readonly relayReservation = true

    /*
     * 취침예약 is 1–7 h on this model, not the 15 h ac_common assumes: the model spec constrains
     * airState.reservation.sleepTime to 60–420 minutes, and the LG app offers the same range.
     */
    readonly sleepTimerMaxMinutes = 420

    /*
     * 0x20e reads 3 (=60분) and 0x225 is present, so this is the writable-duration variant.
     * 30분 and 60분 were written and read back on the hardware; 꺼짐, 10분 and 스마트 (255) are
     * inherited from ac_common's list and untested here. If one of them turns out to be refused
     * it will show as the select snapping back, the same way 파워풍 does in 송풍.
     */
    readonly autoDryLevels: WireLevels = [
        ['꺼짐', 0],
        ['10분', 1],
        ['30분', 2],
        ['60분', 3],
        ['스마트', 255],
    ]

    /*
     * The feature bitmap is reported under 0x2cb; 0x2cc is not sent at all, so the inherited
     * default reads undefined and silently switches off every feature behind it. Measured
     * 0x2cb = 4102 = 0x1006 -> energy saving and auto dry present, air purify absent.
     */
    featureCaps() {
        return this.raw_clip_state[0x2cb]
    }

    /*
     * 0x2cd is reported (0x1FE7B7), and it lies about jet: it claims both jet cooling and jet
     * *heating* on a unit whose own mode bitmap (0x2c1 = 15) has no heat mode at all, and whose
     * jet tag 0x323 was never seen once across 92 tags in three capture sessions — which is why
     * the inherited jet switch sat at `unknown`. CST_570004_WW found the same register
     * untrustworthy.
     *
     * Only the two jet bits are cleared. Its swing bits happen to be right (vertical set,
     * horizontal clear, matching 0x321 present and 0x322 absent), but nothing reads them here:
     * hasSwingVertical/hasSwingHorizontal feed only ac_common's default swingAxes(), which this
     * class replaces outright. So masking rather than returning 0 changes no behaviour today —
     * it is kept because it states what the register actually got right, and keeps the swing
     * path working if the swingAxes() override is ever dropped.
     */
    jetSwingCaps() {
        const caps = this.raw_clip_state[0x2cd]
        return caps == null ? caps : caps & ~0x03
    }

    /*
     * Swing is not two positional axes on this model. 0x321 is the vertical vane *position*,
     * while 0x205 / 0x206 are on/off *rotation* flags — which is also how LG's cloud describes
     * them (airState.wDir.vStep, wDir.upDown, wDir.leftRight). Setting the swing off through
     * 0x321 was observed to drop 0x205 to 0 as well, confirming they describe the same vane.
     *
     * Both are published as climate attributes, because that is the only place Home Assistant's
     * own more-info dialog will render them — and that dialog, not a dashboard card, is what this
     * appliance is actually operated from. `swing_mode` carries the two rotation flags as one
     * control (see SWING_ROTATIONS), and the vane position takes the remaining swing attribute.
     *
     * The position on `swing_horizontal_mode` is a deliberate misuse and the one place this driver
     * knowingly lies: HA translates that attribute as "가로 스윙 모드" and the values in it are the
     * *vertical* vane's six steps. The label cannot be changed — HA owns that vocabulary the same
     * way it owns hvac_mode's — so the choice was between a wrong label inside the dialog and a
     * correct one outside it, where it went unnoticed before. The owner picked the dialog.
     */
    swingAxes(): SwingAxis[] {
        const axes: SwingAxis[] = []
        if (this.raw_clip_state[0x321] != null)
            axes.push({ tag: 0x321, name: 'swing_horizontal_mode', levels: SWING_VERTICAL_STEPS_KR })
        return axes
    }

    /*
     * PRESETS
     *
     * The list is not invented here: it is exactly what the cloud integration already publishes for
     * these seven units (`preset_modes: ['none','송풍2h off','파워풍']`), so the local entity reads
     * the same as the one the house has been using. Reproduced rather than improved on for that
     * reason alone.
     *
     * PRESET_NONE is deliberately NOT in the published list. Home Assistant puts it there itself —
     * mqtt/climate.py inserts PRESET_NONE at the head of preset_modes — and it rejects a discovery
     * payload that already contains it:
     *
     *   valid_preset_mode_configuration: "preset_modes must not include preset mode 'none'"
     *
     * A config that lists it is refused outright, which takes the whole climate entity with it: the
     * other components of the device still appear and the registry entry survives, so it reads as
     * "unavailable" rather than as an error. Publishing the two macros and letting HA prepend the
     * third is what produces the three-entry list above.
     *
     * PRESET_NONE keeps the value 'none' because that is what HA expects to RECEIVE on the state
     * topic for "no preset"; only the advertised list is affected.
     *
     * scripts/validate-discovery-schemas.sh checks this against HA's own schemas before a deploy.
     *
     * They are macros over controls this driver already has — no new appliance capability is
     * implied, and nothing is written that the corresponding entity could not write on its own:
     *
     *   송풍2h off   운전 모드 → 송풍, 그리고 쾌적수면예약 120분
     *   파워풍       풍량 → 파워풍 (wire 7)
     *
     * The timer half is 쾌적수면예약 (0x21a) and not the 꺼짐 예약 relay (0x21b), which is what it
     * used at first. Both turn the unit off later, but only one of them is the timer the LG app's
     * 취침예약 writes — and with the preset on the other one, setting a sleep timer in the app left
     * *two* countdowns running against the same appliance, which is what it looked like on the
     * dashboard. Sharing the tag makes the last action win, which is what a person expects, and it
     * hands the countdown to the appliance instead of a relay that forgets it on restart.
     *
     * It is written through `setProperty('sleeptimer-')` so the preset does exactly what that
     * entity does. Note the unit: ac_common's timer entities are in minutes, and this writes
     * minutes.
     */
    static readonly PRESET_NONE = 'none'
    static readonly PRESET_FAN_2H = '송풍2h off'
    static readonly PRESET_POWER = '파워풍'
    static readonly FAN_2H_MINUTES = 120

    /*
     * Which preset the appliance is currently in, derived from the tags the macros write. Order
     * matters: 송풍2h off is the more specific claim, so it is tested first — 파워풍 in 송풍 with a
     * timer running would otherwise report as the plain fan preset.
     */
    presetFromState(): string {
        const sleepTimer = this.raw_clip_state[0x21a] ?? 0
        if (this.raw_clip_state[0x1f9] === this.modeMaps.toWire.get('fan_only') && sleepTimer > 0)
            return Device.PRESET_FAN_2H
        if (this.raw_clip_state[0x1fa] === this.fanMaps.toWire.get('파워풍')) return Device.PRESET_POWER
        return Device.PRESET_NONE
    }

    /*
     * The preset has no tag of its own — it is a reading of three others — so the field carries the
     * topics only, and the inputs republish it: mode and fan through ac_common's change hooks, and
     * the timer optimistically from the write below.
     *
     * 0x21a deliberately gets no field here. It already has one — ac_common's 쾌적수면예약 number —
     * and `addField` keys `fields_by_id` by tag, so registering it a second time would silently
     * take that entity's publisher away. Reading a tag someone else owns is fine; owning it twice
     * is not.
     */
    addPresetModes(config: DeviceDiscovery) {
        const climate = config.components['climate'] as ClimateComponent
        climate.preset_modes = [Device.PRESET_FAN_2H, Device.PRESET_POWER]

        this.addField(config, { name: 'preset_mode', comp: 'climate', read_callback: () => false })
        this.modeChangeHooks.push(() => this.publishPreset())
        this.fanChangeHooks.push(() => this.publishPreset())

        /*
         * The third input is the sleep timer, and 쾌적수면예약 owns that tag. Rather than take it
         * away, its read is chained: the timer publishes itself exactly as before and the preset
         * follows on the same frame. Without this the preset only moved when the mode or fan did,
         * so cancelling the timer left it reading 송풍2h off with nothing running.
         *
         * addFeatureEntities registers the timer before addModelFields runs, so the field is here.
         */
        const sleepTimer = this.fields_by_id[0x21a]
        if (sleepTimer != null) {
            const chained = sleepTimer.read_callback
            sleepTimer.read_callback = (val) => {
                const publish = chained != null ? chained(val) : true
                this.publishPreset()
                return publish
            }
        }
    }

    publishPreset() {
        this.HA.publishProperty(this.id, 'climate-preset_mode', this.presetFromState())
    }

    /*
     * The second half of the 파워풍 setpoint pair in setProperty: the setpoint HA asked for while
     * 파워풍 was running, held until the appliance reports it has left.
     *
     * It is cleared on the first fan change either way. That change is the one the fan write above
     * asked for, so nothing can survive to be applied against some later, unrelated fan change.
     */
    pendingSetpoint: string | undefined

    addPowerFanSetpointRetry() {
        this.fanChangeHooks.push(() => {
            const pending = this.pendingSetpoint
            if (pending == null) return
            this.pendingSetpoint = undefined
            if (this.raw_clip_state[0x1fa] !== this.fanMaps.toWire.get('파워풍'))
                this.setProperty('climate-temperature', pending)
        })
    }

    /* Both rotation flags as one label. A flag the unit has not reported yet counts as off. */
    swingRotationLabel(): string {
        const ud = this.raw_clip_state[0x205] ? 1 : 0
        const lr = this.raw_clip_state[0x206] ? 1 : 0
        return (SWING_ROTATIONS.find((r) => r.ud === ud && r.lr === lr) ?? SWING_ROTATIONS[0]).label
    }

    /*
     * The climate swing control, over 0x205 + 0x206.
     *
     * 0x205 owns the pair's HA topics; 0x206 is registered without any of its own (autoreg off) and
     * exists only so that a change to either flag republishes the combined label. Both reads go
     * through the same callback and return false, because the value HA gets is derived from the two
     * tags together rather than from whichever one moved. The write needs both tags in one frame,
     * which addField cannot express, so it is handled in setProperty below.
     */
    addSwingRotation(config: DeviceDiscovery) {
        if (this.raw_clip_state[0x205] == null && this.raw_clip_state[0x206] == null) return

        const climate = config.components['climate'] as ClimateComponent
        climate.swing_modes = SWING_ROTATIONS.map((r) => r.label)

        const republish = () => {
            this.HA.publishProperty(this.id, 'climate-swing_mode', this.swingRotationLabel())
            return false
        }

        this.addField(config, { id: 0x205, name: 'swing_mode', comp: 'climate', read_callback: republish })
        this.addField(
            config,
            {
                id: 0x206,
                name: 'swing_lr',
                comp: 'climate',
                readable: false,
                writable: false,
                read_callback: republish,
            },
            false,
        )
    }

    autoDryStyle() {
        return 'select' as const
    }

    /*
     * 0x355 (remaining) and 0x356 (rated life) are both reported — 47 and 2400 — so the filter is
     * read from the value tags. The priv-command path RAC uses does not apply: 0x2f1 reads 513
     * with bit 0 set, which is the "unsupported mFilter" case.
     */
    filterStyle() {
        return 'valueTags' as const
    }

    addModelFields(config: DeviceDiscovery) {
        /*
         * Display brightness (0x21f). The cloud reports exactly {100, 150, 200} for
         * airState.lightingState.displayControl on these units, and this one read 150 while its
         * panel sat at half brightness.
         */
        this.addValueSelect(config, 'display', 0x21f, '디스플레이 밝기', 'mdi:brightness-6', [
            ['꺼짐', 100],
            ['50%', 150],
            ['100%', 200],
        ])

        /* Room humidity (0x336, raw/10 = %RH). Read 470 while the cloud reported 47 %. */
        this.addOptionalSensorField(
            config,
            0x336,
            'humidity',
            '습도',
            undefined,
            {
                device_class: 'humidity',
                unit_of_measurement: '%',
                state_class: 'measurement',
                suggested_display_precision: 0,
                entity_category: undefined,
            },
            (raw) => Math.round(raw / 10),
        )

        /*
         * 0x2b5 — the shared outdoor unit's total power draw, in watts.
         *
         * On a single appliance this tag was ambiguous: it climbs, but not in step with that
         * unit's own 0x2b3 (their ratio moved from 10.9 to 21.7 across one fan step) and not
         * monotonically, which ruled out both "scaled copy of the power reading" and "cumulative
         * energy counter". Reading it off all seven units at once settled it — **every unit
         * reports the identical value**, which no per-appliance quantity can be.
         *
         * It is the ODU total, and the per-IDU 0x2b3 values are shares of it. Measured twice,
         * 90 s apart, while three units were cooling:
         *
         *   sum(0x2b3) 3549 W  vs  0x2b5 3469 W   -> 80 W
         *   sum(0x2b3) 3341 W  vs  0x2b5 3261 W   -> 80 W
         *
         * The residual is a constant 80 W, not drift — four IDUs were reporting in both rounds,
         * so it is consistent with a fixed ~20 W indoor-unit allowance per IDU being counted in
         * 0x2b3 but not in the ODU figure.
         *
         * Every unit publishes its own copy of this sensor. That is seven identical entities,
         * which is redundant but honest: the tag really is reported per device, and picking one
         * unit to be "the" ODU sensor would break as soon as that unit is powered off.
         */
        this.addOptionalSensorField(config, 0x2b5, 'odu_power', '실외기 총 소비전력', 'mdi:heat-pump-outline', {
            device_class: 'power',
            unit_of_measurement: 'W',
            state_class: 'measurement',
            suggested_display_precision: 0,
            entity_category: undefined,
        })

        /* 회전 (0x205 + 0x206) on the climate entity; the vane position rides swingAxes above. */
        this.addSwingRotation(config)
        this.addPresetModes(config)
        this.addPowerFanSetpointRetry()

        /*
         * Comfort energy saving (0x23f): only effective in cool mode, and distinct from the plain
         * energy saving on 0x20d that ac_common exposes.
         */
        if (this.raw_clip_state[0x23f] != null)
            this.addConfigSwitchField(config, 0x23f, 'comfort_saving', '쾌적 절전', 'mdi:leaf')

        this.addWindModeSelect(config)
        this.koreanLabels(config)
    }

    /*
     * Wind mode (comfort airflow): five mutually-exclusive one-hot flags, all five of which this
     * unit reports. Exposed as a single select, since the hardware only ever has one of them set.
     * Reads derive the mode from whichever flag is up; the write is handled in setProperty.
     */
    addWindModeSelect(config: DeviceDiscovery) {
        if (this.raw_clip_state[0x3d6] == null || config.components['wind_mode']) return

        config.components['wind_mode'] = allowExtendedType({
            platform: 'select',
            unique_id: '$deviceid-wind_mode',
            name: '바람 모드',
            icon: 'mdi:weather-windy',
            entity_category: 'config',
            options: Object.keys(Device.WIND_TO_FLAG),
            state_topic: '$this/wind_mode',
            command_topic: '$this/wind_mode/set',
        })

        for (const id of Device.WIND_FLAGS) {
            this.addField(
                config,
                {
                    id,
                    name: `flag_${id.toString(16)}`,
                    comp: 'wind_mode',
                    readable: false,
                    writable: false,
                    read_callback: () => {
                        this.HA.publishProperty(this.id, 'wind_mode', this.windModeFromState())
                        return false
                    },
                },
                false,
            )
        }
    }

    // 0x290 auto temp, 0x291 study, 0x3d5 release, 0x3d6 manner, 0x3d7 long power.
    static readonly WIND_FLAGS = [0x290, 0x291, 0x3d5, 0x3d6, 0x3d7]
    static readonly WIND_TO_FLAG: Record<string, number | undefined> = {
        꺼짐: undefined,
        매너: 0x3d6,
        롱파워: 0x3d7,
        스터디: 0x291,
        자동온도: 0x290,
    }

    windModeFromState(): string {
        if (this.raw_clip_state[0x3d6]) return '매너'
        if (this.raw_clip_state[0x3d7]) return '롱파워'
        if (this.raw_clip_state[0x291]) return '스터디'
        if (this.raw_clip_state[0x290]) return '자동온도'
        return '꺼짐'
    }

    /*
     * The two "turn off later" timers are mutually exclusive, and are made so here.
     *
     * 쾌적수면예약 (0x21a) is counted down by the appliance; 꺼짐 예약 (0x21b) is counted down by
     * relayReservation in this process. Nothing stops both from being armed at once, and when that
     * happened the dashboard showed two countdowns against one appliance and the earlier one won by
     * accident. There is one appliance and one intent, so setting either clears the other and the
     * last thing asked for is the thing that happens.
     *
     * `timerExclusive` keeps the clearing write from bouncing back and clearing the one just set.
     */
    timerExclusive = false
    static readonly TIMER_PEER: Record<string, { prop: string; tag: number }> = {
        'sleeptimer-': { prop: 'stoptimer-', tag: 0x21b },
        'stoptimer-': { prop: 'sleeptimer-', tag: 0x21a },
    }

    setProperty(prop: string, mqttValue: string) {
        const peer = Device.TIMER_PEER[prop]
        if (peer != null && !this.timerExclusive) {
            this.timerExclusive = true
            try {
                super.setProperty(prop, mqttValue)
                if (Number(mqttValue) > 0 && (this.raw_clip_state[peer.tag] ?? 0) > 0) this.setProperty(peer.prop, '0')
            } finally {
                this.timerExclusive = false
            }
            /* 송풍2h off reads off the sleep timer, so a timer write can retire it. Do not wait for
             * the appliance to echo the tag back - that is up to 28 s of showing a preset that is
             * no longer running. */
            this.publishPreset()
            return
        }
        if (prop === 'wind_mode') {
            const on = Device.WIND_TO_FLAG[mqttValue]
            // select one flag exclusively: chosen=1, everything else (incl. 0x3d5 release)=0
            const tlv = Device.WIND_FLAGS.map((id) => ({ t: id, v: id === on ? 1 : 0 }))
            for (const { t, v } of tlv) this.raw_clip_state[t] = v
            this.send([1, 1, 2, 1, 1], tlv)
            return
        }
        if (prop === 'climate-preset_mode') {
            /*
             * Each preset is written as the entity writes it would have been, so the appliance sees
             * nothing it has not already accepted from those paths. Cancelling clears the timer and
             * leaves mode and fan where they are — the appliance has no "undo the preset" concept
             * and guessing a previous state would be inventing one.
             */
            if (mqttValue === Device.PRESET_FAN_2H) {
                this.setProperty('climate-mode', 'fan_only')
                this.setProperty('sleeptimer-', String(Device.FAN_2H_MINUTES))
            } else if (mqttValue === Device.PRESET_POWER) {
                this.setProperty('climate-fan_mode', '파워풍')
            } else if (mqttValue === Device.PRESET_NONE) {
                this.setProperty('sleeptimer-', '0')
            } else return

            /* The timer has no read hook here (0x21a belongs to 쾌적수면예약), so echo the new state. */
            this.publishPreset()
            return
        }
        if (prop === 'climate-swing_mode') {
            // one label, two tags: both go out in a single frame so the vanes move together
            const rotation = SWING_ROTATIONS.find((r) => r.label === mqttValue)
            if (rotation == null) return
            const tlv = [
                { t: 0x205, v: rotation.ud },
                { t: 0x206, v: rotation.lr },
            ]
            for (const { t, v } of tlv) this.raw_clip_state[t] = v
            this.send([1, 1, 2, 1, 1], tlv)
            return
        }
        /*
         * A setpoint cannot travel in the frame that ends 파워풍. It takes two frames, and this is
         * the first of them. Read off a live unit by injecting single frames and letting the
         * appliance answer, with 27 degC (0x1fe=54) set before 파워풍 was entered:
         *
         *   {0x1fa=7, 0x1f9=0, 0x1fe=54}  -> answers 0x1fe=36. Entering 파워풍 pins 18 degC.
         *   {0x1fe=52, 0x1f9=0, 0x1fa=6}  -> answers 0x1fe=36, 0x1fa=6. This is the frame a plain
         *                                    temperature write sends, and it is the whole bug: the
         *                                    26 degC is dropped, 파워풍 ends anyway, and the card
         *                                    keeps the 18 degC 파워풍 had pinned.
         *   {0x1fa=6, 0x1f9=0, 0x1fe=36}  -> answers 0x1fe=54. Leaving 파워풍 puts the setpoint back
         *                                    to what it was before, and the frame's own 0x1fe is
         *                                    ignored while it does so.
         *   {0x1fe=52, 0x1f9=0, 0x1fa=6}  -> answers 0x1fe=52. Once out of 파워풍 the ordinary
         *                                    temperature write lands, at +0.1 s and at +1 s alike.
         *
         * So: end 파워풍 with the fan write, and send the setpoint on the appliance's own report
         * that it has left — fanChangeHooks, see addPowerFanSetpointRetry. Waiting for that report
         * rather than counting milliseconds is what makes the pair reliable.
         *
         * 파워풍 cannot be kept either way: it is the thing pinning 18 degC, which is exactly what
         * the setpoint is being moved away from. 강풍 is not a guess at what to put in its place —
         * it is where this unit takes itself when 파워풍 ends, with 약풍 running beforehand it still
         * came back at 강풍.
         */
        if (prop === 'climate-temperature' && this.raw_clip_state[0x1fa] === this.fanMaps.toWire.get('파워풍')) {
            this.pendingSetpoint = mqttValue
            this.setProperty('climate-fan_mode', '강풍')
            return
        }
        super.setProperty(prop, mqttValue)
    }

    /*
     * ac_common names its entities in English, which is right for a shared base class but leaves
     * this appliance labelled half in Korean (the fan speeds) and half in English. This renames
     * the ones it creates so the whole device reads in one language — the one the LG app and the
     * appliance's own panel use.
     */
    koreanLabels(config: DeviceDiscovery) {
        const names: Record<string, string> = {
            error: '에러 코드',
            capacity: '정격 냉방능력',
            eev: '전자팽창밸브 개도',
            pipeintemp: '배관 액관 온도',
            pipeouttemp: '배관 가스관 온도',
            oduhextemp: '실외기 열교환기 온도',
            oduairtemp: '실외기 외기 온도',
            fanrpm: '실내팬 회전수',
            energy_current: '소비 전력',
            energysave: '절전',
            airclean: '공기청정',
            jet: '제트',
            autodry_setting: '자동 건조',
            autodryremain: '자동 건조 잔여',
            filter_remaining: '필터 잔여',
            filter_used: '필터 사용 시간',
            filter_life: '필터 수명',
            filterused: '필터 사용 시간',
            filterlife: '필터 수명',
            filterchangeddate: '필터 교체일',
            filterreset: '필터 사용량 초기화',
            /*
             * 0x21a is what the LG app calls 쾌적수면예약, so it is named that rather than
             * "sleep timer". The unit reports and runs that one itself.
             *
             * The app does offer an on/off reservation for this model — the earlier reading of
             * the 0x2d3 bitmap was wrong, and the screen that would have shown it was failing for
             * an unrelated reason. 0x21b / 0x21c are still never reported and never acted on, so
             * those two are run by relayReservation instead. Wall-clock skew does not reach them:
             * the app sends minutes from now, not a time of day.
             */
            sleeptimer: '쾌적수면예약',
            starttimer: '켜짐 예약',
            stoptimer: '꺼짐 예약',
        }
        applyKoreanNames(config, names)
    }
}
