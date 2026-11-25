import { Connection, Model, Schema } from 'mongoose'
import { RunEvent, RunSnapshot, RunStatus, RunStore } from './types'
import { redactEvent } from './redaction'
import { RunStoreError } from './runStore'

export interface MongoRunFilter {
    readonly id: string
    readonly version?: number
    readonly status?: RunStatus | { readonly $nin: readonly RunStatus[] } | { readonly $in: readonly RunStatus[] }
    readonly stepCount?: number | { readonly $lte?: number; readonly $gte?: number }
    readonly toolCallCount?: number | { readonly $lte?: number; readonly $gte?: number }
}

export interface MongoRunUpdate {
    readonly $inc?: { readonly version: number }
    readonly $set?: Partial<Pick<RunSnapshot, 'status' | 'updatedAt' | 'stepCount' | 'toolCallCount' | 'output'>>
    readonly $push?: { readonly events: RunEvent }
}

/** Narrow collection contract keeps persistence mechanics testable without a Mongo daemon. */
export interface MongoRunCollection {
    insertOne(snapshot: RunSnapshot): Promise<void>
    findOne(filter: { readonly id: string; readonly tenantId?: string; readonly principalId?: string }): Promise<RunSnapshot | null>
    findOneAndUpdate(filter: MongoRunFilter, update: MongoRunUpdate): Promise<RunSnapshot | null>
}

const TERMINAL: readonly RunStatus[] = ['succeeded', 'failed', 'cancelled']
const TRANSITIONS: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
    queued: ['running', 'cancelled', 'failed'],
    running: ['waiting_for_approval', 'succeeded', 'failed', 'cancelled'],
    waiting_for_approval: ['running', 'cancelled', 'failed'],
    succeeded: [],
    failed: [],
    cancelled: [],
}

/** Durable adapter; requires MongoDB atomic single-document updates. */
export class MongoRunStore implements RunStore {
    constructor(private readonly collection: MongoRunCollection, private readonly clock: () => number = Date.now) {}

    async create(snapshot: RunSnapshot): Promise<void> {
        if (snapshot.status !== 'queued' || snapshot.version !== 0 || snapshot.events.length !== 0) {
            throw new RunStoreError('new runs must start queued at version zero with no events')
        }
        try {
            await this.collection.insertOne(snapshot)
        } catch (error) {
            if (isDuplicateKeyError(error)) throw new RunStoreError('run id already exists')
            throw error
        }
    }

    async get(id: string, scope: { tenantId: string; principalId: string }): Promise<RunSnapshot | null> {
        return this.collection.findOne({ id, ...scope })
    }

    async appendEvent(id: string, runEvent: RunEvent, expectedVersion: number): Promise<RunSnapshot> {
        const updated = await this.collection.findOneAndUpdate(
            { id, version: expectedVersion, status: { $nin: TERMINAL } },
            {
                $inc: { version: 1 },
                $set: { updatedAt: runEvent.at },
                $push: { events: redactEvent(runEvent) },
            }
        )
        if (updated) return updated
        return this.throwConflict(id, expectedVersion, 'cannot append to a terminal run')
    }

    async transition(
        id: string,
        nextStatus: RunStatus,
        patch: { output?: string; stepCount?: number; toolCallCount?: number },
        expectedVersion: number
    ): Promise<RunSnapshot> {
        const current = await this.collection.findOne({ id })
        if (!current) throw new RunStoreError('run does not exist')
        if (current.version !== expectedVersion) throw new RunStoreError('run version conflict')
        if (!TRANSITIONS[current.status].includes(nextStatus)) {
            throw new RunStoreError(`invalid run transition: ${current.status} -> ${nextStatus}`)
        }

        const stepCount = patch.stepCount ?? current.stepCount
        const toolCallCount = patch.toolCallCount ?? current.toolCallCount
        if (
            !Number.isInteger(stepCount) ||
            !Number.isInteger(toolCallCount) ||
            stepCount < current.stepCount ||
            toolCallCount < current.toolCallCount ||
            toolCallCount > stepCount
        ) {
            throw new RunStoreError('run counters must be monotonic and internally consistent')
        }

        const filter: MongoRunFilter = {
            id,
            version: current.version,
            status: current.status,
            stepCount: current.stepCount,
            toolCallCount: current.toolCallCount,
        }
        const set: NonNullable<MongoRunUpdate['$set']> = {
            status: nextStatus,
            stepCount,
            toolCallCount,
            updatedAt: this.clock(),
            ...(Object.prototype.hasOwnProperty.call(patch, 'output') ? { output: patch.output } : {}),
        }
        const updated = await this.collection.findOneAndUpdate(filter, {
            $inc: { version: 1 },
            $set: set,
        })
        if (updated) return updated
        return this.throwConflict(id, expectedVersion, 'run version conflict')
    }

    private async throwConflict(id: string, expectedVersion: number, terminalMessage: string): Promise<never> {
        const current = await this.collection.findOne({ id })
        if (!current) throw new RunStoreError('run does not exist')
        if (current.version !== expectedVersion) {
            throw new RunStoreError(`run version conflict: expected ${expectedVersion}, found ${current.version}`)
        }
        if (TERMINAL.includes(current.status)) throw new RunStoreError(terminalMessage)
        throw new RunStoreError('run state changed concurrently')
    }
}

/** Create (or reuse) the strict Mongoose model used by MongoRunStore. */
export const createMongoRunCollection = (connection: Connection): MongoRunCollection => {
    const existing = connection.models.AgentRun
    const model = (existing ?? connection.model('AgentRun', createRunSchema())) as Model<Record<string, unknown>>
    return new MongooseRunCollection(model)
}

class MongooseRunCollection implements MongoRunCollection {
    constructor(private readonly model: Model<Record<string, unknown>>) {}

    async insertOne(snapshot: RunSnapshot): Promise<void> {
        await this.model.create(snapshot)
    }

    async findOne(filter: {
        readonly id: string
        readonly tenantId?: string
        readonly principalId?: string
    }): Promise<RunSnapshot | null> {
        const found = await this.model.findOne(filter).lean().exec()
        return found ? toSnapshot(found) : null
    }

    async findOneAndUpdate(filter: MongoRunFilter, update: MongoRunUpdate): Promise<RunSnapshot | null> {
        const found = await this.model.findOneAndUpdate(filter, update, {
            new: true,
            runValidators: true,
            strict: 'throw',
        }).lean().exec()
        return found ? toSnapshot(found) : null
    }
}

const createRunSchema = (): Schema => {
    const eventSchema = new Schema(
        {
            type: {
                type: String,
                required: true,
                enum: [
                    'run_created', 'run_started', 'model_step_started', 'tool_call_requested',
                    'tool_call_denied', 'approval_required', 'tool_call_started',
                    'tool_call_succeeded', 'tool_call_failed', 'run_succeeded', 'run_failed',
                    'run_cancelled',
                ],
            },
            at: { type: Number, required: true },
            step: { type: Number, min: 0 },
            toolName: { type: String, maxlength: 64 },
            status: { type: String, enum: ['queued', 'running', 'waiting_for_approval', 'succeeded', 'failed', 'cancelled'] },
            detail: { type: Schema.Types.Mixed },
        },
        { _id: false, strict: 'throw' }
    )
    const schema = new Schema(
        {
            id: { type: String, required: true, minlength: 8, maxlength: 96 },
            tenantId: { type: String, required: true, maxlength: 128 },
            principalId: { type: String, required: true, maxlength: 128 },
            status: {
                type: String,
                required: true,
                enum: ['queued', 'running', 'waiting_for_approval', 'succeeded', 'failed', 'cancelled'],
            },
            version: { type: Number, required: true, min: 0 },
            stepCount: { type: Number, required: true, min: 0 },
            toolCallCount: { type: Number, required: true, min: 0 },
            createdAt: { type: Number, required: true },
            updatedAt: { type: Number, required: true },
            output: { type: String, maxlength: 32_000 },
            events: { type: [eventSchema], default: [] },
        },
        {
            collection: 'agent_runs',
            versionKey: false,
            minimize: false,
            strict: 'throw',
        }
    )
    schema.index({ id: 1 }, { unique: true })
    schema.index({ tenantId: 1, principalId: 1, createdAt: -1 })
    return schema
}

const toSnapshot = (value: Record<string, unknown>): RunSnapshot => {
    const snapshot = { ...value }
    delete snapshot._id
    return snapshot as unknown as RunSnapshot
}

const isDuplicateKeyError = (error: unknown): boolean =>
    typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 11000
