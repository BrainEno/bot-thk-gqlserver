import {
    ApprovalRequestRecord,
    ApprovalWorkflow,
    RunEvent,
    RunSnapshot,
    RunStore,
    RunStatus,
} from './types'
import { RunStoreError } from './runStore'

export type ApprovalLifecycleOutcome =
    | 'approved'
    | 'rejected'
    | 'expired'
    | 'already_decided'
    | 'not_found'
    | 'not_due'
    | 'not_authorized'
    | 'stale'
    | 'invalid_request'

export interface ApprovalLifecycleResult {
    readonly outcome: ApprovalLifecycleOutcome
    readonly approvalId: string
    readonly runId: string
    readonly runStatus?: RunStatus
}

/** Values derived from the authenticated review context, never directly from request JSON. */
export interface ApprovalReviewInput {
    readonly approvalId: string
    readonly runId: string
    readonly tenantId: string
    readonly reviewerId: string
}

/** Values derived from a trusted tenant-scoped scheduler or administrative worker. */
export interface ApprovalExpiryInput {
    readonly approvalId: string
    readonly runId: string
    readonly tenantId: string
}

export interface ApprovalExpiryBatchInput {
    readonly tenantId: string
    readonly limit: number
}

export interface ApprovalExpiryBatchResult {
    readonly scanned: number
    readonly expired: number
    readonly alreadyResolved: number
    readonly stale: number
    readonly invalidRequest: boolean
    readonly outcomes: readonly ApprovalLifecycleResult[]
}

const MAX_LIFECYCLE_EXPIRY_BATCH_SIZE = 100

const RUN_ID_PATTERN = /^[A-Za-z0-9_-]{8,96}$/
const APPROVAL_ID_PATTERN = /^[A-Za-z0-9_-]{22,128}$/
const MAX_IDENTITY_LENGTH = 128
const RECONCILE_ATTEMPTS = 3

/**
 * Coordinates durable human decisions with a waiting run. The actual HTTP/GraphQL
 * authentication layer is deliberately outside this class; callers must derive
 * reviewerId and tenantId from a verified identity, not trust client-supplied IDs.
 */
export class AgentApprovalLifecycle {
    constructor(
        private readonly approvals: ApprovalWorkflow,
        private readonly runs: RunStore,
        private readonly clock: () => number = Date.now
    ) {}

    async approve(input: ApprovalReviewInput): Promise<ApprovalLifecycleResult> {
        return this.review(input, 'approve')
    }

    async reject(input: ApprovalReviewInput): Promise<ApprovalLifecycleResult> {
        return this.review(input, 'reject')
    }

    /** Mark an elapsed pending request expired and close its run, or repair a prior partial close. */
    async expire(input: ApprovalExpiryInput): Promise<ApprovalLifecycleResult> {
        if (!isExpiryInput(input)) return invalidResult(input)
        const record = await this.approvals.get(input.approvalId, input.tenantId)
        if (!record || record.runId !== input.runId) return result('not_found', input)
        if (record.state === 'expired') return this.closeExpired(record)
        if (record.state !== 'pending') return this.currentDecision(record)

        const now = this.clock()
        if (record.expiresAt > now) return result('not_due', input)
        const changed = await this.approvals.expire(record.id, record.tenantId, now)
        if (changed) {
            const expired = await this.approvals.get(record.id, record.tenantId)
            return expired?.state === 'expired'
                ? this.closeExpired(expired)
                : result('stale', input)
        }

        const latest = await this.approvals.get(record.id, record.tenantId)
        if (!latest) return result('not_found', input)
        if (latest.state === 'expired') return this.closeExpired(latest)
        return this.currentDecision(latest)
    }

    /** Process a bounded tenant-scoped page; schedulers should invoke this repeatedly. */
    async expireBatch(input: ApprovalExpiryBatchInput): Promise<ApprovalExpiryBatchResult> {
        if (
            !input ||
            !isIdentity(input.tenantId) ||
            !Number.isInteger(input.limit) ||
            input.limit < 1 ||
            input.limit > MAX_LIFECYCLE_EXPIRY_BATCH_SIZE
        ) {
            return {
                scanned: 0,
                expired: 0,
                alreadyResolved: 0,
                stale: 0,
                invalidRequest: true,
                outcomes: [],
            }
        }
        const candidates = await this.approvals.listExpired(input.tenantId, this.clock(), input.limit)
        const outcomes: ApprovalLifecycleResult[] = []
        for (const candidate of candidates) {
            outcomes.push(await this.expire({
                approvalId: candidate.id,
                runId: candidate.runId,
                tenantId: candidate.tenantId,
            }))
        }
        return {
            scanned: outcomes.length,
            expired: outcomes.filter((entry) => entry.outcome === 'expired').length,
            alreadyResolved: outcomes.filter((entry) => entry.outcome === 'already_decided').length,
            stale: outcomes.filter((entry) => entry.outcome === 'stale').length,
            invalidRequest: false,
            outcomes,
        }
    }

    private async review(
        input: ApprovalReviewInput,
        decision: 'approve' | 'reject'
    ): Promise<ApprovalLifecycleResult> {
        if (!isReviewInput(input)) return invalidResult(input)
        const record = await this.approvals.get(input.approvalId, input.tenantId)
        if (!record || record.runId !== input.runId) return result('not_found', input)
        if (record.state === 'rejected') return this.closeRejected(record)
        if (record.state === 'expired') return this.closeExpired(record)
        if (record.state !== 'pending') return this.currentDecision(record)

        const now = this.clock()
        if (record.expiresAt <= now) {
            const expired = await this.expire({
                approvalId: input.approvalId,
                runId: input.runId,
                tenantId: input.tenantId,
            })
            return expired.outcome === 'not_due' ? result('stale', input) : expired
        }
        if (record.requestedBy === input.reviewerId) return result('not_authorized', input)
        const snapshot = await this.getMatchingWaitingRun(record)
        if (!snapshot) return result('stale', input)

        const changed = decision === 'approve'
            ? await this.approvals.approve(record.id, record.tenantId, input.reviewerId, now)
            : await this.approvals.reject(record.id, record.tenantId, input.reviewerId, now)
        if (changed) {
            if (decision === 'approve') return result('approved', input, snapshot.status)
            return this.closeRejected(record)
        }

        const latest = await this.approvals.get(record.id, record.tenantId)
        if (!latest) return result('not_found', input)
        if (latest.state === 'rejected') return this.closeRejected(latest)
        if (latest.state === 'expired') return this.closeExpired(latest)
        return this.currentDecision(latest)
    }

    private async closeRejected(record: ApprovalRequestRecord): Promise<ApprovalLifecycleResult> {
        return this.closeRun(record, 'cancelled', 'approval_rejected', 'rejected')
    }

    private async closeExpired(record: ApprovalRequestRecord): Promise<ApprovalLifecycleResult> {
        return this.closeRun(record, 'failed', 'approval_expired', 'expired')
    }

    private async closeRun(
        record: ApprovalRequestRecord,
        nextStatus: 'cancelled' | 'failed',
        eventType: 'approval_rejected' | 'approval_expired',
        outcome: 'rejected' | 'expired'
    ): Promise<ApprovalLifecycleResult> {
        for (let attempt = 0; attempt < RECONCILE_ATTEMPTS; attempt += 1) {
            const snapshot = await this.getScopedRun(record)
            if (!snapshot) return result('stale', record)
            if (snapshot.status !== 'waiting_for_approval') {
                return { ...result(outcome, record, snapshot.status), outcome }
            }
            if (!matchesPending(snapshot, record)) return result('stale', record, snapshot.status)

            const lifecycleEvent: RunEvent = {
                type: eventType,
                at: this.clock(),
                status: nextStatus,
                toolName: record.toolName,
                detail: { approvalId: record.id },
            }
            try {
                const updated = await this.runs.transition(
                    record.runId,
                    nextStatus,
                    {
                        checkpoint: null,
                        pendingApproval: null,
                        event: lifecycleEvent,
                    },
                    snapshot.version
                )
                return result(outcome, record, updated.status)
            } catch (error) {
                if (!isVersionConflict(error)) throw error
            }
        }
        const finalSnapshot = await this.getScopedRun(record)
        if (finalSnapshot && finalSnapshot.status !== 'waiting_for_approval') {
            return result(outcome, record, finalSnapshot.status)
        }
        return result('stale', record, finalSnapshot?.status)
    }

    private async getMatchingWaitingRun(record: ApprovalRequestRecord): Promise<RunSnapshot | null> {
        const snapshot = await this.getScopedRun(record)
        return snapshot && snapshot.status === 'waiting_for_approval' && matchesPending(snapshot, record)
            ? snapshot
            : null
    }

    private getScopedRun(record: ApprovalRequestRecord): Promise<RunSnapshot | null> {
        return this.runs.get(record.runId, {
            tenantId: record.tenantId,
            principalId: record.principalId,
        })
    }

    private currentDecision(record: ApprovalRequestRecord): ApprovalLifecycleResult {
        if (record.state === 'rejected') return result('rejected', record)
        if (record.state === 'expired') return result('expired', record)
        if (record.state === 'approved' || record.state === 'consumed') return result('already_decided', record)
        return result('stale', record)
    }
}

const matchesPending = (snapshot: RunSnapshot, record: ApprovalRequestRecord): boolean =>
    Boolean(
        snapshot.status === 'waiting_for_approval' &&
            snapshot.pendingApproval &&
            snapshot.checkpoint &&
            snapshot.pendingApproval.id === record.id &&
            snapshot.pendingApproval.toolName === record.toolName &&
            snapshot.pendingApproval.inputDigest === record.inputDigest &&
            snapshot.pendingApproval.expiresAt === record.expiresAt
    )

const isReviewInput = (input: ApprovalReviewInput): boolean =>
    Boolean(
        isExpiryInput(input) &&
            isIdentity(input.reviewerId)
    )

const isExpiryInput = (input: ApprovalExpiryInput): boolean =>
    Boolean(
        input &&
            typeof input === 'object' &&
            APPROVAL_ID_PATTERN.test(input.approvalId) &&
            RUN_ID_PATTERN.test(input.runId) &&
            isIdentity(input.tenantId)
    )

const isIdentity = (value: unknown): value is string =>
    typeof value === 'string' && value.trim().length > 0 && value.length <= MAX_IDENTITY_LENGTH

const isVersionConflict = (error: unknown): boolean =>
    error instanceof RunStoreError && error.message.startsWith('run version conflict')

const result = (
    outcome: ApprovalLifecycleOutcome,
    input: { readonly approvalId?: string; readonly id?: string; readonly runId: string },
    runStatus?: RunStatus
): ApprovalLifecycleResult => ({
    outcome,
    approvalId: input.approvalId ?? input.id ?? '',
    runId: input.runId,
    runStatus,
})

const invalidResult = (
    input: { readonly approvalId?: string; readonly runId?: string } | null | undefined
): ApprovalLifecycleResult => ({
    outcome: 'invalid_request',
    approvalId: typeof input?.approvalId === 'string' ? input.approvalId : '',
    runId: typeof input?.runId === 'string' ? input.runId : '',
})
