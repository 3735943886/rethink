/*
 * Put a clip cmd in front of a real appliance and watch what it says back.
 *
 * The management /device websocket carries packets - the payload inside cmd `device_packet` - so it
 * cannot ask an appliance anything at the cmd layer above that. rethink's internal broker can:
 * it grants every subscription and asks for no credentials, so a plain MQTT client on the debug
 * port (`mqtt_port`, 1884 by default) can both forge a cloud->appliance message, by publishing to
 * lime/devices/<did>, and watch the appliance's side of the conversation, by subscribing to clip/#.
 *
 * Nothing is injected into rethink's own handling. lime/ is not a clip topic, so DeviceAcceptor
 * ignores the forgery and only the appliance acts on it; and the reply arrives on the appliance's
 * own connection, so it takes the same path it always would.
 *
 * Only the cloud->appliance direction works this way. Forging the reverse by publishing to
 * clip/message/devices/<did> does not reach the bridge: DeviceAcceptor resolves the device from the
 * publishing client, and this tool is not the appliance.
 *
 * Usage, and the exchange that motivated it - what the cloud asks before it offers any firmware:
 *
 *   tsx tools/clip-probe.ts 10.0.0.1:1884 <did> reqUniversalCtrl 0 \
 *     '{"reqType":"online_check","messageId":"probe-1","clientId":"x"}'
 *
 * The appliance answers `respUniversalCtrl`, echoing reqType/messageId/clientId and adding
 * `responseCode: "0000"`. `reqType: "device_status"` is the other one the firmware advertises
 * (appInfo.modemConfig lists both) and returns rather more: rollbackInfo, build date, and a
 * `pcbInfo` packet holding one part number per updatable micom.
 */
import * as mqtt from 'mqtt'

const USAGE = `usage:
  watch:  tsx clip-probe.ts host:port --watch [did] [listenSecs]
  probe:  tsx clip-probe.ts host:port <did> <cmd> [type] [dataJson] [listenSecs]`

const argv = process.argv.slice(2)
const broker = argv[0]
const watching = argv[1] === '--watch'

// In watch mode the appliance is not addressed, so `did` is only a filter and may be left out.
const [did, cmd, typeArg, dataArg, secsArg] = watching
    ? [argv[2], undefined, undefined, undefined, argv[3]]
    : argv.slice(1)

if (!broker || (!watching && (!did || !cmd))) {
    console.error(USAGE)
    process.exit(1)
}

const type = Number(typeArg ?? 0)
const data = JSON.parse(dataArg ?? '{}')
// Watching is for an exchange somebody else sets off - a press of "update" in the ThinQ app - so it
// runs until stopped unless told otherwise. A probe knows when it is done.
const listenMs = Number(secsArg ?? (watching ? 0 : 30)) * 1000

// Both halves of the appliance's conversation: clip/ is what it publishes, lime/ is what rethink
// publishes to it - including anything the bridge relays down from the real cloud.
const TOPICS = ['clip/#', 'lime/#']

const client = mqtt.connect('mqtt://' + broker, { clientId: 'clip-probe-' + process.pid })

function stamp() {
    return new Date().toISOString()
}

let subscribed = false

client.on('connect', () => {
    console.log(`${stamp()} connected to ${broker}`)
    // Subscribing wide means a message arriving on an unexpected topic still shows up instead of
    // vanishing; `did` filters the output, not the subscription.
    client.subscribe(TOPICS, (err) => {
        if (err) {
            console.error('subscribe failed', err)
            process.exit(1)
        }
        console.log(
            `${stamp()} subscribed to ${TOPICS.join(' ')}` +
                (did ? ` filtered to ${did}` : ' (all devices)') +
                (listenMs ? `, ${listenMs / 1000}s` : ', until stopped'),
        )

        // A reconnect after rethink restarts must not fire the probe a second time.
        if (subscribed) return
        subscribed = true

        if (watching) return

        const msg = JSON.stringify({ did, mid: Date.now(), cmd, type, data })
        console.log(`${stamp()} PUBLISH lime/devices/${did} ${msg}`)
        client.publish('lime/devices/' + did, msg + ' ')
    })
})

client.on('reconnect', () => console.log(`${stamp()} reconnecting...`))
client.on('close', () => console.log(`${stamp()} disconnected`))

client.on('message', (topic, payload) => {
    if (did && !topic.includes(did)) return

    const text = payload.toString('utf-8').replace(/\0+$/, '').trim()
    let cmdName = '?'
    try {
        cmdName = JSON.parse(text).cmd ?? '?'
    } catch {
        /* print it raw below anyway */
    }

    // device_packet is the ordinary state traffic and drowns everything else out.
    if (cmdName === 'device_packet') return

    console.log(`${stamp()} RECV [${cmdName}] ${topic}`)
    console.log(`    ${text}`)
})

client.on('error', (err) => console.error(`${stamp()} error`, err))

// listenMs of 0 means "until stopped" - no deadline at all, rather than one that fires immediately.
if (listenMs > 0)
    setTimeout(() => {
        console.log(`${stamp()} done`)
        client.end()
        process.exit(0)
    }, listenMs)
