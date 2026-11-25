import assert from 'node:assert/strict'
import test from 'node:test'
import {
    AgentTool,
    ApprovalGrant,
    ApprovalVerifier,
    PermissionPolicy,
    ToolRegistry,
    digestJson,
} from '../src/agentic'

const readTool: AgentTool = {
    name: 'lookup_record',
    description: 'Read one public record by identifier.',
    inputSchema: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string', minLength: 1, maxLength: 32 } },
    },
    sideEffect: 'read_only',
    requiredPermissions: ['records_read'],
    execute: async () => ({ ok: true }),
}

const writeTool: AgentTool = {
    name: 'publish_draft',
    description: 'Publish a draft after a human approval.',
    inputSchema: {
        type: 'object',
        required: ['draftId'],
        properties: { draftId: { type: 'string', minLength: 1, maxLength: 32 } },
    },
    sideEffect: 'write',
    requiredPermissions: ['drafts_write'],
    execute: async () => ({ published: true }),
}

const principal = {
    id: 'user-17',
    tenantId: 'tenant-a',
    permissions: ['records_read', 'drafts_write'],
}

test('registry accepts unique, bounded lowercase tool identifiers', () => {
    const registry = new ToolRegistry().register(readTool)
    assert.deepEqual(registry.names(), ['lookup_record'])
    assert.equal(registry.get('lookup_record')?.sideEffect, 'read_only')
})

test('registry prevents duplicate, malformed, and late registrations', () => {
    const registry = new ToolRegistry().register(readTool)
    assert.throws(() => registry.register(readTool), /already registered/)
    assert.throws(
        () => registry.register({ ...readTool, name: 'shell.exec' }),
        /lowercase identifier/
    )
    registry.seal()
    assert.throws(
        () => registry.register({ ...writeTool, name: 'send_message' }),
        /sealed/
    )
})

test('registry rejects unsafe or inconsistent tool schemas', () => {
    const registry = new ToolRegistry()
    assert.throws(
        () => registry.register({ ...readTool, inputSchema: { type: 'array' } }),
        /must define items/
    )
    assert.throws(
        () => registry.register({
            ...readTool,
            inputSchema: {
                type: 'object',
                properties: { id: { type: 'number', minimum: 9, maximum: 2 } },
            },
        }),
        /range is inverted/
    )
    const reservedProperties = JSON.parse('{"__proto__":{"type":"string"}}')
    assert.throws(
        () => registry.register({
            ...readTool,
            inputSchema: { type: 'object', properties: reservedProperties },
        }),
        /reserved property name/
    )
})

test('permission policy permits scoped read tools and denies missing permissions', async () => {
    const policy = new PermissionPolicy()
    const allowed = await policy.authorize({
        runId: 'run-12345678',
        principal,
        tool: readTool,
        args: { id: 'public-1' },
        now: 100,
    })
    assert.deepEqual(allowed, { kind: 'allow' })

    const denied = await policy.authorize({
        runId: 'run-12345678',
        principal: { ...principal, permissions: [] },
        tool: readTool,
        args: { id: 'public-1' },
        now: 100,
    })
    assert.deepEqual(denied, { kind: 'deny', reason: 'missing required permission' })
})

test('write tools always require a grant bound to run, principal, tenant, tool, and input digest', async () => {
    const policy = new PermissionPolicy()
    const args = { draftId: 'draft-4' }
    const digest = digestJson(args)
    const grant: ApprovalGrant = {
        id: 'grant-1',
        runId: 'run-12345678',
        principalId: principal.id,
        tenantId: principal.tenantId,
        toolName: writeTool.name,
        inputDigest: digest,
        expiresAt: 10_000,
    }

    const pending = await policy.authorize({
        runId: grant.runId,
        principal,
        tool: writeTool,
        args,
        now: 100,
    })
    assert.deepEqual(pending, { kind: 'approval_required', inputDigest: digest })

    const verifier = new ExactMatchApprovalVerifier(grant)
    const approved = await new PermissionPolicy(verifier).authorize({
        runId: grant.runId,
        principal,
        tool: writeTool,
        args,
        approval: grant,
        now: 200,
    })
    assert.deepEqual(approved, { kind: 'allow' })
    assert.equal(verifier.consumed, true)
})

test('approval grants cannot be replayed, expired, or transferred', async () => {
    const args = { draftId: 'draft-4' }
    const grant: ApprovalGrant = {
        id: 'grant-2',
        runId: 'run-12345678',
        principalId: principal.id,
        tenantId: principal.tenantId,
        toolName: writeTool.name,
        inputDigest: digestJson(args),
        expiresAt: 100,
    }
    const verifier = new ExactMatchApprovalVerifier(grant)
    const policy = new PermissionPolicy(verifier)
    const claims = {
        runId: grant.runId,
        principal,
        tool: writeTool,
        args,
        approval: grant,
        now: 101,
    }
    assert.equal((await policy.authorize(claims)).kind, 'deny')
    assert.equal(verifier.consumed, false)

    const validGrant = { ...grant, id: 'grant-3', expiresAt: 1_000 }
    const validVerifier = new ExactMatchApprovalVerifier(validGrant)
    const validPolicy = new PermissionPolicy(validVerifier)
    assert.equal((await validPolicy.authorize({ ...claims, approval: validGrant, now: 99 })).kind, 'allow')
    assert.equal((await validPolicy.authorize({ ...claims, approval: validGrant, now: 99 })).kind, 'deny')
    assert.equal(validVerifier.consumed, true)

    const transferVerifier = new ExactMatchApprovalVerifier(validGrant)
    const transferPolicy = new PermissionPolicy(transferVerifier)
    assert.equal((await transferPolicy.authorize({
        ...claims,
        approval: validGrant,
        principal: { ...principal, id: 'other-user' },
        now: 99,
    })).kind, 'deny')
})

class ExactMatchApprovalVerifier implements ApprovalVerifier {
    consumed = false

    constructor(private readonly expected: ApprovalGrant) {}

    async consume(grant: ApprovalGrant, claims: Parameters<ApprovalVerifier['consume']>[1]) {
        const matches =
            !this.consumed &&
            grant.id === this.expected.id &&
            grant.runId === claims.runId &&
            grant.principalId === claims.principalId &&
            grant.tenantId === claims.tenantId &&
            grant.toolName === claims.toolName &&
            grant.inputDigest === claims.inputDigest &&
            grant.expiresAt > claims.now
        if (matches) this.consumed = true
        return matches
    }
}
