import { RunEvent, TraceSink } from './types'
import { redactEvent } from './redaction'

export interface TraceEventRecord {
    readonly runId: string
    readonly tenantId: string
    readonly event: RunEvent
}

export interface TraceEventWriter {
    write(record: TraceEventRecord): Promise<void>
}

export class RedactingTraceSink implements TraceSink {
    constructor(private readonly writer: TraceEventWriter) {}

    async emit(event: RunEvent, scope: { runId: string; tenantId: string }): Promise<void> {
        await this.writer.write({
            ...scope,
            event: redactEvent(event),
        })
    }
}

export class NoopTraceSink implements TraceSink {
    async emit(): Promise<void> {
        // Tracing is opt-in; no prompt or tool data is retained by default.
    }
}

/** In-memory writer for deterministic tests. Do not use as production persistence. */
export class MemoryTraceWriter implements TraceEventWriter {
    private readonly records: TraceEventRecord[] = []

    async write(record: TraceEventRecord): Promise<void> {
        this.records.push(record)
    }

    readAll(): readonly TraceEventRecord[] {
        return this.records.map((record) => ({
            ...record,
            event: redactEvent(record.event),
        }))
    }
}
