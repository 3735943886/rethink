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
// Both of those are inferences from a single failure, and a single failure is not always what it
// looks like - a caller that was never going to accept rethink's CA in the first place (nothing
// pins it but an appliance that fetched it from /route/certificate) produces the identical
// rejection on a host rethink has no business ever passing through. #confirmedLocal in this file
// exists to make that mistake impossible to repeat for a host proven to work locally, whatever
// noteUrlsIn or the reactive path later think they saw.
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

    // Hosts rethink is known to answer itself - proven by a client actually completing a request
    // against the certificate issued for it, not merely by a certificate having been minted (an
    // appliance, or anything else, can still reject that cert). This exists because of an incident:
    // kic-common.lgthinq.com - the shared API host practically every appliance and the real ThinQ
    // app itself talks to - got one rejected handshake (an unrelated caller, not pinned to rethink's
    // CA, most likely) that the reactive path in note() below misread as "wants a real root," and
    // passed the whole host through from then on. That host is exactly the one this set exists to
    // protect: it must never be added to #hosts, no matter what evidence turns up later, because a
    // false positive here is not one broken download - it is every appliance's control breaking at
    // once. See rethink-cloud.ts for where this gets marked true.
    #confirmedLocal = new Set<string>()

    /** Record that a client has completed a real request against a certificate issued for `host`. */
    confirmLocal(host: string) {
        this.#confirmedLocal.add(host)
        this.#hosts.delete(host)
    }

    /**
     * Register the host of a firmware URL the cloud has just handed an appliance. Anything that is
     * not a parseable http(s) URL is ignored, and so is a host already proven to work when rethink
     * answers it directly - see #confirmedLocal above.
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

        if (this.#confirmedLocal.has(host)) {
            log('status', `refusing to pass ${host} through - rethink has already answered it directly`)
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
