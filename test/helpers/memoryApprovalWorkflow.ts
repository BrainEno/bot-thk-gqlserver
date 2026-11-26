import {
    ApprovalClaims,
    ApprovalGrant,
    ApprovalRequestRecord,
    ApprovalWorkflow,
} from '../../src/agentic'

export class MemoryApprovalWorkflow implements ApprovalWorkflow {
    private readonly records = new Map<string, ApprovalRequestRecord>()

    async createPending(grant: ApprovalGrant, requestedBy: string, requestedAt = Date.now()): Promise<void> {
        if (this.records.has(grant.id)) throw new Error('duplicate test approval')
        this.records.set(grant.id, {
            ...grant,
            state: 'pending',
            requestedBy,
            requestedAt,
        })
    }

    async get(id: string, tenantId: string): Promise<ApprovalRequestRecord | null> {
        const record = this.records.get(id)
        return record?.tenantId === tenantId ? { ...record } : null
    }

    async approve(id: string, tenantId: string, reviewerId: string, now = Date.now()): Promise<boolean> {
        const record = this.records.get(id)
        if (
            !record ||
            record.tenantId !== tenantId ||
            record.state !== 'pending' ||
            record.requestedBy === reviewerId ||
            record.expiresAt <= now
        ) return false
        this.records.set(id, { ...record, state: 'approved', decidedBy: reviewerId, decidedAt: now })
        return true
    }

    async reject(id: string, tenantId: string, reviewerId: string, now = Date.now()): Promise<boolean> {
        const record = this.records.get(id)
        if (
            !record ||
            record.tenantId !== tenantId ||
            record.state !== 'pending' ||
            record.requestedBy === reviewerId ||
            record.expiresAt <= now
        ) return false
        this.records.set(id, { ...record, state: 'rejected', decidedBy: reviewerId, decidedAt: now })
        return true
    }

    async consume(grant: ApprovalGrant, claims: ApprovalClaims): Promise<boolean> {
        const record = this.records.get(grant.id)
        const matches = Boolean(
            record &&
                record.state === 'approved' &&
                record.id === grant.id &&
                record.runId === claims.runId &&
                record.principalId === claims.principalId &&
                record.tenantId === claims.tenantId &&
                record.toolName === claims.toolName &&
                record.inputDigest === claims.inputDigest &&
                record.expiresAt === grant.expiresAt &&
                record.expiresAt > claims.now
        )
        if (!matches || !record) return false
        this.records.set(grant.id, { ...record, state: 'consumed' })
        return true
    }
}
