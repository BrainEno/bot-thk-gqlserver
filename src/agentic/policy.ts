import {
    AgentPolicy,
    ApprovalVerifier,
    JsonValue,
    PolicyDecision,
} from './types'
import { digestJson } from './canonicalJson'

export class PermissionPolicy implements AgentPolicy {
    constructor(private readonly approvalVerifier?: ApprovalVerifier) {}

    async authorize(input: Parameters<AgentPolicy['authorize']>[0]): Promise<PolicyDecision> {
        const permissions = new Set(input.principal.permissions)
        const missing = input.tool.requiredPermissions.filter(
            (permission) => !permissions.has(permission)
        )
        if (missing.length > 0) {
            return { kind: 'deny', reason: 'missing required permission' }
        }

        if (input.tool.sideEffect === 'read_only') return { kind: 'allow' }

        const inputDigest = digestJson(input.args as JsonValue)
        if (!input.approval) {
            return { kind: 'approval_required', inputDigest }
        }
        if (!this.approvalVerifier) {
            return { kind: 'deny', reason: 'approval verifier is not configured' }
        }

        const valid = await this.approvalVerifier.consume(input.approval, {
            runId: input.runId,
            principalId: input.principal.id,
            tenantId: input.principal.tenantId,
            toolName: input.tool.name,
            inputDigest,
            now: input.now,
        })
        return valid
            ? { kind: 'allow' }
            : { kind: 'deny', reason: 'approval is invalid, expired, or already consumed' }
    }
}
