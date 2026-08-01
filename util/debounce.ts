/**
 * Actions scheduled per key, where scheduling or cancelling a key supersedes whatever was already
 * waiting for it. Used to hold back an event for long enough to see whether it is about to be
 * undone.
 */
export class KeyedDebounce {
    private readonly pending = new Map<string, NodeJS.Timeout>()

    /** Run `action` after `delayMs`, replacing anything already pending for `key`. */
    defer(key: string, delayMs: number, action: () => void) {
        this.cancel(key)

        // unref'd: something waiting to be undone must never be the reason the process stays alive
        const timer = setTimeout(() => {
            this.pending.delete(key)
            action()
        }, delayMs)

        this.pending.set(key, timer.unref?.() ?? timer)
    }

    /** Drop whatever was pending for `key`, if anything. */
    cancel(key: string) {
        const timer = this.pending.get(key)
        if (timer === undefined) return

        clearTimeout(timer)
        this.pending.delete(key)
    }

    /** Whether an action is currently waiting for `key`. Exposed for tests. */
    isPending(key: string) {
        return this.pending.has(key)
    }
}
