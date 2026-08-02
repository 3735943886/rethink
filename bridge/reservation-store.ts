import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { validDeviceId } from '@/util/device-id'

/*
 * Where a driver that runs the LG app's on/off reservation itself keeps it.
 *
 * What is stored is the absolute wall-clock deadline, not the minutes that were asked for: a
 * restart is not a reason for a two-hour timer to start again from two hours. A deadline already
 * in the past is dropped on load rather than fired late - the appliance has been left alone for
 * however long rethink was down, and switching it on the moment rethink comes back would be
 * acting on an intent that expired.
 */
export type ReservationDeadlines = {
    start?: number
    stop?: number
}

export type ReservationStore = {
    load(id: string): ReservationDeadlines
    save(id: string, deadlines: ReservationDeadlines): void
}

type ReservationFileOps = {
    read(path: string): string
    write(path: string, data: string): void
    rename(from: string, to: string): void
}

type ReservationWarning = (message: string, error: unknown) => void

const fileOps: ReservationFileOps = {
    read: (path) => readFileSync(path, 'utf-8'),
    write: (path, data) => writeFileSync(path, data, { mode: 0o600 }),
    rename: (from, to) => renameSync(from, to),
}

export class ReservationJSONStore implements ReservationStore {
    private tempSequence = 0

    constructor(
        readonly basePath: string,
        private readonly now: () => number = Date.now,
        private readonly files: ReservationFileOps = fileOps,
        private readonly warn: ReservationWarning = console.warn,
    ) {}

    private path(id: string) {
        if (!validDeviceId(id)) return undefined
        return join(this.basePath, `reservation_${id}.json`)
    }

    load(id: string): ReservationDeadlines {
        const path = this.path(id)
        if (!path) return {}

        let serialized: string
        try {
            serialized = this.files.read(path)
        } catch (error) {
            /* Never having had a reservation is the ordinary case, not a failure. */
            if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return {}
            this.warn(`Unable to read reservation state ${path}`, error)
            throw error
        }

        let stored: Record<string, unknown>
        try {
            const parsed = JSON.parse(serialized) as unknown
            if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed))
                throw new Error('reservation state must be a JSON object')
            stored = parsed as Record<string, unknown>
        } catch (error) {
            /* A file we cannot read is a timer nobody set, which is the safe reading of it. */
            this.warn(`Ignoring corrupt reservation state ${path}`, error)
            return {}
        }

        const now = this.now()
        const deadlines: ReservationDeadlines = {}
        if (typeof stored.start === 'number' && Number.isFinite(stored.start) && stored.start > now)
            deadlines.start = stored.start
        if (typeof stored.stop === 'number' && Number.isFinite(stored.stop) && stored.stop > now)
            deadlines.stop = stored.stop
        return deadlines
    }

    save(id: string, deadlines: ReservationDeadlines) {
        const path = this.path(id)
        if (!path) return

        const stored: ReservationDeadlines = {}
        if (typeof deadlines.start === 'number' && Number.isFinite(deadlines.start)) stored.start = deadlines.start
        if (typeof deadlines.stop === 'number' && Number.isFinite(deadlines.stop)) stored.stop = deadlines.stop

        /* Written aside and renamed into place: a half-written file would read as no reservation. */
        const tempPath = `${path}.${process.pid}.${this.tempSequence++}.tmp`
        this.files.write(tempPath, JSON.stringify(stored))
        this.files.rename(tempPath, path)
    }
}
