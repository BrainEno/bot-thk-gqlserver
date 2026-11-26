import { JsonValue, RunEvent, RunSnapshot, RunStatus, RunStore } from './types'
import { redactEvent } from './redaction'

export class RunStoreError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'RunStoreError'
    }
}

const TERMINAL = new Set<RunStatus>(['succeeded', 'failed', 'cancelled'])
const TRANSITIONS: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
    queued: ['running', 'cancelled', 'failed'],
    running: ['waiting_for_approval', 'succeeded', 'failed', 'cancelled'],
    waiting_for_approval: ['running', 'cancelled', 'failed'],
    succeeded: [],
    failed: [],
    cancelled: [],
}

/** Test/local adapter only. Production requires a durable transactional RunStore. */
export class InMemoryRunStore implements RunStore {
    private readonly records = new Map<string, RunSnapshot>()

    constructor(private readonly clock: () => number = Date.now) {}

    async create(snapshot: RunSnapshot): Promise<void> {
        if (this.records.has(snapshot.id)) {
            throw new RunStoreError('run id already exists')
        }
        if (snapshot.status !== 'queued' || snapshot.version !== 0) {
            throw new RunStoreError('new runs must start queued at version zero')
        }
        this.records.set(snapshot.id, cloneSnapshot(snapshot))
    }

    async get(
        id: string,
        scope: { tenantId: string; principalId: string }
    ): Promise<RunSnapshot | null> {
        const record = this.records.get(id)
        if (
            !record ||
            record.tenantId !== scope.tenantId ||
            record.principalId !== scope.principalId
        ) {
            return null
        }
        return cloneSnapshot(record)
    }

    async appendEvent(
        id: string,
        event: RunEvent,
        expectedVersion: number
    ): Promise<RunSnapshot> {
        const current = this.requireRecord(id, expectedVersion)
        if (TERMINAL.has(current.status)) {
            throw new RunStoreError('cannot append to a terminal run')
        }
        const next = cloneSnapshot({
            ...current,
            version: current.version + 1,
            updatedAt: event.at,
            events: [...current.events, redactEvent(event)],
        })
        this.records.set(id, next)
        return cloneSnapshot(next)
    }

    async transition(
        id: string,
        nextStatus: RunStatus,
        patch: {
            output?: string
            stepCount?: number
            toolCallCount?: number
            checkpoint?: RunSnapshot['checkpoint'] | null
            pendingApproval?: RunSnapshot['pendingApproval'] | null
        },
        expectedVersion: number
    ): Promise<RunSnapshot> {
        const current = this.requireRecord(id, expectedVersion)
        if (!TRANSITIONS[current.status].includes(nextStatus)) {
            throw new RunStoreError(`invalid run transition: ${current.status} -> ${nextStatus}`)
        }
        const stepCount = patch.stepCount ?? current.stepCount
        const toolCallCount = patch.toolCallCount ?? current.toolCallCount
        if (
            stepCount < current.stepCount ||
            toolCallCount < current.toolCallCount ||
            toolCallCount > stepCount
        ) {
            throw new RunStoreError('run counters must be monotonic and internally consistent')
        }
        const { checkpoint, pendingApproval, ...ordinaryPatch } = patch
        const next = cloneSnapshot({
            ...current,
            ...ordinaryPatch,
            ...(Object.prototype.hasOwnProperty.call(patch, 'checkpoint')
                ? { checkpoint: checkpoint ?? undefined }
                : {}),
            ...(Object.prototype.hasOwnProperty.call(patch, 'pendingApproval')
                ? { pendingApproval: pendingApproval ?? undefined }
                : {}),
            status: nextStatus,
            stepCount,
            toolCallCount,
            version: current.version + 1,
            updatedAt: this.clock(),
        })
        this.records.set(id, next)
        return cloneSnapshot(next)
    }

    private requireRecord(id: string, expectedVersion: number): RunSnapshot {
        const record = this.records.get(id)
        if (!record) throw new RunStoreError('run does not exist')
        if (record.version !== expectedVersion) {
            throw new RunStoreError('run version conflict')
        }
        return record
    }
}

const cloneSnapshot = (snapshot: RunSnapshot): RunSnapshot => ({
    ...snapshot,
    checkpoint: snapshot.checkpoint ? { ...snapshot.checkpoint } : undefined,
    pendingApproval: snapshot.pendingApproval ? { ...snapshot.pendingApproval } : undefined,
    events: snapshot.events.map((event) => ({
        ...event,
        detail: event.detail ? cloneJson(event.detail) as Readonly<Record<string, JsonValue>> : undefined,
    })),
})

const cloneJson = (value: JsonValue): JsonValue => {
    if (value === null || typeof value !== 'object') return value
    if (Array.isArray(value)) return value.map(cloneJson)
    const clone: Record<string, import('./types').JsonValue> = {}
    for (const [key, child] of Object.entries(value)) {
        Object.defineProperty(clone, key, {
            value: cloneJson(child),
            enumerable: true,
            configurable: true,
            writable: true,
        })
    }
    return clone
}
