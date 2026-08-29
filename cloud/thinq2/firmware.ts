// Where an appliance's firmware comes from.
//
// An appliance that reaches rethink by port redirection sends it every connection it makes on 443,
// including ones rethink has no business answering. A firmware download is the case that matters:
// the image lives on a public CDN and the appliance checks that certificate against its built-in
// roots, not the CA it pinned from /route/certificate, so a certificate rethink signs is refused
// and the connection is dropped mid-handshake - before there is any request to answer.
//
// Those connections have to reach the real server instead, and to route one, rethink has to know
// the name belongs to a download. Hardcoding a CDN would only hold for the one region it was read
// off, and there is more than one cmd shape that hands an appliance a URL to fetch on its own -
// startFota is the original one, but SOTA app content (osp_command/osp_report) does the same thing
// under a field this was never told the name of, and likely differs by cmd or region. So this is
// learned two ways: proactively, by noteUrlsIn scanning every cloud->device message for anything
// that parses as an http(s) URL, whatever cmd or field carried it; and reactively, when a name
// terminated here gets the exact rejection a firmware host produces - the appliance resets the
// handshake before sending a request, because it wanted a real root, not ours - which needs no cmd
// or field to be spotted at all, only for the appliance to have tried and failed once.
//
// See cloud/thinq2/sni-passthrough for what is done with it.

import log from '@/util/logging'

export class FirmwareHosts {
    // Deliberately empty. Naming a CDN here would contradict the point - it would be right for one
    // region and wrong elsewhere - and it would also mask this: with a host already present, an
    // update succeeds whether or not startFota was read correctly, so there would be no way to
    // tell. The cost is the few seconds between startFota and the download it announces: a restart
    // of rethink inside that window loses the host and the update fails, which asking for it again
    // puts right.
    #hosts = new Set<string>()

    /**
     * Register the host of a firmware URL the cloud has just handed an appliance. Anything that is
     * not a parseable http(s) URL is ignored.
     */
    note(downloadUrl: unknown) {
        if (typeof downloadUrl !== 'string') return

        let host: string
        try {
            const parsed = new URL(downloadUrl)
            if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return
            host = parsed.hostname
        } catch {
            return
        }

        // Logged even when the host is already known, because otherwise this path is silent from
        // the second update onwards and there is no way to tell it ran at all.
        log('status', `firmware download announced for ${host}${this.#hosts.has(host) ? '' : ' (new host)'}`)
        this.#hosts.add(host)
    }

    /**
     * Walk an arbitrary cloud→device payload and note() every http(s) URL found in it, at any
     * depth and under any field name.
     *
     * startFota is not the only cmd that hands an appliance a URL to fetch on its own: SOTA app
     * content (osp_command/osp_report, e.g. installing a NIGHT_GLARE-style feature) does the same
     * thing under a field this was never told the name of, and likely differs by cmd or region.
     * Rather than chase each cmd's exact field path, treat any string that parses as an http(s)
     * URL anywhere in the payload as one - note() already discards anything that isn't.
     */
    noteUrlsIn(payload: unknown, seen = new Set<unknown>()) {
        if (typeof payload === 'string') {
            this.note(payload)
        } else if (Array.isArray(payload)) {
            if (seen.has(payload)) return
            seen.add(payload)
            for (const item of payload) this.noteUrlsIn(item, seen)
        } else if (payload && typeof payload === 'object') {
            if (seen.has(payload)) return
            seen.add(payload)
            for (const value of Object.values(payload)) this.noteUrlsIn(value, seen)
        }
    }

    /**
     * Whether a TLS server name belongs to a firmware download, and so should be handed to the real
     * server rather than answered here.
     */
    has(name: string) {
        return this.#hosts.has(name)
    }

    /** Exposed for tests. */
    all() {
        return [...this.#hosts]
    }
}
