import { Connection, Model, Schema } from 'mongoose'
import { ApprovalClaims, ApprovalGrant, ApprovalWorkflow } from './types'

export type ApprovalState = 'pending' | 'approved' | 'rejected' | 'expired' | 'consumed'

export const MAX_APPROVAL_EXPIRY_BATCH_SIZE = 100

export interface StoredApproval extends ApprovalGrant {
    readonly state: ApprovalState
    readonly requestedBy: string
    readonly requestedAt: number
    readonly decidedBy?: string
    readonly decidedAt?: number
    readonly consumedAt?: number
}

export interface MongoApprovalFilter {
    readonly id: string
    readonly tenantId?: string
    readonly runId?: string
    readonly principalId?: string
    readonly toolName?: string
    readonly inputDigest?: string
    readonly expiresAt?: number | { readonly $gt: number } | { readonly $lte: number }
    readonly state?: ApprovalState
    readonly requestedBy?: string | { readonly $ne: string }
}

export interface MongoApprovalUpdate {
    readonly $set: Partial<Pick<StoredApproval, 'state' | 'decidedBy' | 'decidedAt' | 'consumedAt'>>
}

export interface MongoApprovalCollection {
    insertOne(record: StoredApproval): Promise<void>
    findOne(filter: { readonly id: string; readonly tenantId: string }): Promise<StoredApproval | null>
    findOneAndUpdate(filter: MongoApprovalFilter, update: MongoApprovalUpdate): Promise<StoredApproval | null>
    listPendingExpired(tenantId: string, now: number, limit: number): Promise<readonly StoredApproval[]>
}

export class ApprovalStoreError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'ApprovalStoreError'
    }
}

/** Durable, single-use approval records. Human issuance/decision routes remain separate. */
export class MongoApprovalStore implements ApprovalWorkflow {
    constructor(private readonly collection: MongoApprovalCollection) {}

    async createPending(
        grant: ApprovalGrant,
        requestedBy: string,
        requestedAt = Date.now()
    ): Promise<void> {
        assertGrant(grant, requestedBy, requestedAt)
        const record: StoredApproval = {
            ...grant,
            state: 'pending',
            requestedBy,
            requestedAt,
        }
        try {
            await this.collection.insertOne(record)
        } catch (error) {
            if (isDuplicateKeyError(error)) throw new ApprovalStoreError('approval id already exists')
            throw error
        }
    }

    async get(id: string, tenantId: string): Promise<StoredApproval | null> {
        if (!isApprovalId(id) || !isIdentity(tenantId)) return null
        return this.collection.findOne({ id, tenantId })
    }

    async approve(id: string, tenantId: string, approverId: string, now = Date.now()): Promise<boolean> {
        if (!isApprovalId(id) || !isIdentity(tenantId) || !isIdentity(approverId) || !Number.isFinite(now)) {
            return false
        }
        const updated = await this.collection.findOneAndUpdate(
            {
                id,
                tenantId,
                state: 'pending',
                expiresAt: { $gt: now },
                requestedBy: { $ne: approverId },
            },
            { $set: { state: 'approved', decidedBy: approverId, decidedAt: now } }
        )
        return Boolean(updated)
    }

    async reject(id: string, tenantId: string, reviewerId: string, now = Date.now()): Promise<boolean> {
        if (!isApprovalId(id) || !isIdentity(tenantId) || !isIdentity(reviewerId) || !Number.isFinite(now)) {
            return false
        }
        const updated = await this.collection.findOneAndUpdate(
            {
                id,
                tenantId,
                state: 'pending',
                expiresAt: { $gt: now },
                requestedBy: { $ne: reviewerId },
            },
            { $set: { state: 'rejected', decidedBy: reviewerId, decidedAt: now } }
        )
        return Boolean(updated)
    }

    async expire(id: string, tenantId: string, now = Date.now()): Promise<boolean> {
        if (!isApprovalId(id) || !isIdentity(tenantId) || !Number.isFinite(now)) return false
        const updated = await this.collection.findOneAndUpdate(
            {
                id,
                tenantId,
                state: 'pending',
                expiresAt: { $lte: now },
            },
            { $set: { state: 'expired', decidedAt: now } }
        )
        return Boolean(updated)
    }

    async listExpired(tenantId: string, now: number, limit: number): Promise<readonly StoredApproval[]> {
        if (
            !isIdentity(tenantId) ||
            !Number.isFinite(now) ||
            !Number.isInteger(limit) ||
            limit < 1 ||
            limit > MAX_APPROVAL_EXPIRY_BATCH_SIZE
        ) return []
        return this.collection.listPendingExpired(tenantId, now, limit)
    }

    async consume(grant: ApprovalGrant, claims: ApprovalClaims): Promise<boolean> {
        if (!matchesClaims(grant, claims)) return false
        const updated = await this.collection.findOneAndUpdate(
            {
                id: grant.id,
                runId: claims.runId,
                principalId: claims.principalId,
                tenantId: claims.tenantId,
                toolName: claims.toolName,
                inputDigest: claims.inputDigest,
                expiresAt: grant.expiresAt,
                state: 'approved',
            },
            { $set: { state: 'consumed', consumedAt: claims.now } }
        )
        return Boolean(updated)
    }
}

export const createMongoApprovalCollection = (connection: Connection): MongoApprovalCollection => {
    const existing = connection.models.AgentApproval
    const model = (existing ?? connection.model('AgentApproval', createApprovalSchema())) as Model<Record<string, unknown>>
    return new MongooseApprovalCollection(model)
}

class MongooseApprovalCollection implements MongoApprovalCollection {
    constructor(private readonly model: Model<Record<string, unknown>>) {}

    async insertOne(record: StoredApproval): Promise<void> {
        await this.model.create(record)
    }

    async findOne(filter: { readonly id: string; readonly tenantId: string }): Promise<StoredApproval | null> {
        const found = await this.model.findOne(filter).lean().exec()
        return found ? toStoredApproval(found) : null
    }

    async findOneAndUpdate(
        filter: MongoApprovalFilter,
        update: MongoApprovalUpdate
    ): Promise<StoredApproval | null> {
        const found = await this.model.findOneAndUpdate(filter, update, {
            new: true,
            runValidators: true,
            strict: 'throw',
        }).lean().exec()
        return found ? toStoredApproval(found) : null
    }

    async listPendingExpired(tenantId: string, now: number, limit: number): Promise<readonly StoredApproval[]> {
        const records = await this.model.find({ tenantId, state: 'pending', expiresAt: { $lte: now } })
            .sort({ expiresAt: 1, id: 1 })
            .limit(limit)
            .lean()
            .exec()
        return records.map(toStoredApproval)
    }
}

const createApprovalSchema = (): Schema => {
    const schema = new Schema(
        {
            id: { type: String, required: true, minlength: 22, maxlength: 128 },
            runId: { type: String, required: true, minlength: 8, maxlength: 96 },
            principalId: { type: String, required: true, maxlength: 128 },
            tenantId: { type: String, required: true, maxlength: 128 },
            toolName: { type: String, required: true, maxlength: 64 },
            inputDigest: { type: String, required: true, match: /^[a-f0-9]{64}$/ },
            expiresAt: { type: Number, required: true },
            state: { type: String, required: true, enum: ['pending', 'approved', 'rejected', 'expired', 'consumed'] },
            requestedBy: { type: String, required: true, maxlength: 128 },
            requestedAt: { type: Number, required: true },
            decidedBy: { type: String, maxlength: 128 },
            decidedAt: { type: Number },
            consumedAt: { type: Number },
        },
        {
            collection: 'agent_approvals',
            versionKey: false,
            strict: 'throw',
        }
    )
    schema.index({ id: 1 }, { unique: true })
    schema.index({ tenantId: 1, runId: 1, state: 1 })
    schema.index({ tenantId: 1, state: 1, expiresAt: 1, id: 1 })
    schema.index({ expiresAt: 1 })
    return schema
}

const assertGrant = (grant: ApprovalGrant, requestedBy: string, requestedAt: number): void => {
    if (
        !grant ||
        !isApprovalId(grant.id) ||
        !isIdentity(grant.runId) ||
        !isIdentity(grant.tenantId) ||
        !isIdentity(grant.principalId) ||
        !isToolName(grant.toolName) ||
        !/^[a-f0-9]{64}$/.test(grant.inputDigest) ||
        !isIdentity(requestedBy) ||
        requestedBy !== grant.principalId ||
        !Number.isFinite(grant.expiresAt) ||
        grant.expiresAt <= requestedAt ||
        !Number.isFinite(requestedAt)
    ) {
        throw new ApprovalStoreError('approval request is invalid')
    }
}

const matchesClaims = (grant: ApprovalGrant, claims: ApprovalClaims): boolean =>
    Boolean(
        grant &&
            claims &&
            isApprovalId(grant.id) &&
            grant.runId === claims.runId &&
            grant.principalId === claims.principalId &&
            grant.tenantId === claims.tenantId &&
            grant.toolName === claims.toolName &&
            grant.inputDigest === claims.inputDigest &&
            Number.isFinite(grant.expiresAt) &&
            grant.expiresAt > claims.now &&
            Number.isFinite(claims.now)
    )

const isIdentity = (value: unknown): value is string =>
    typeof value === 'string' && value.trim().length > 0 && value.length <= 128

const isToolName = (value: unknown): value is string =>
    typeof value === 'string' && /^[a-z][a-z0-9_]{1,63}$/.test(value)

const isApprovalId = (value: unknown): value is string =>
    typeof value === 'string' && /^[A-Za-z0-9_-]{22,128}$/.test(value)

const toStoredApproval = (value: Record<string, unknown>): StoredApproval => {
    const record = { ...value }
    delete record._id
    return record as unknown as StoredApproval
}

const isDuplicateKeyError = (error: unknown): boolean =>
    typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 11000
