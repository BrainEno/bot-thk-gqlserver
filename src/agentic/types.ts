import { JsonSchema } from './validation'

export type RunStatus =
    | 'queued'
    | 'running'
    | 'waiting_for_approval'
    | 'succeeded'
    | 'failed'
    | 'cancelled'

export type RunEventType =
    | 'run_created'
    | 'run_started'
    | 'model_step_started'
    | 'tool_call_requested'
    | 'tool_call_denied'
    | 'approval_required'
    | 'tool_call_started'
    | 'tool_call_succeeded'
    | 'tool_call_failed'
    | 'run_succeeded'
    | 'run_failed'
    | 'run_cancelled'

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }

export interface AgentPrincipal {
    readonly id: string
    readonly tenantId: string
    readonly permissions: readonly string[]
}

export interface AgentMessage {
    readonly role: 'user' | 'assistant' | 'tool'
    readonly content: string
    readonly toolCallId?: string
}

export interface ModelToolDescription {
    readonly name: string
    readonly description: string
    readonly inputSchema: JsonSchema
}

export interface ModelRequest {
    readonly runId: string
    readonly messages: readonly AgentMessage[]
    readonly tools: readonly ModelToolDescription[]
    readonly signal: AbortSignal
}

export type ModelDecision =
    | { readonly kind: 'final'; readonly output: string }
    | {
          readonly kind: 'tool_call'
          readonly callId: string
          readonly name: string
          readonly input: unknown
      }

export interface ModelProvider {
    nextAction(request: ModelRequest): Promise<ModelDecision>
}

export type ToolSideEffect = 'read_only' | 'write'

export interface AgentToolContext {
    readonly runId: string
    readonly principal: AgentPrincipal
    readonly signal: AbortSignal
}

export interface AgentTool {
    readonly name: string
    readonly description: string
    readonly inputSchema: JsonSchema
    readonly sideEffect: ToolSideEffect
    readonly requiredPermissions: readonly string[]
    execute(input: JsonValue, context: AgentToolContext): Promise<JsonValue>
}

export interface ApprovalGrant {
    readonly id: string
    readonly runId: string
    readonly principalId: string
    readonly tenantId: string
    readonly toolName: string
    readonly inputDigest: string
    readonly expiresAt: number
}

export interface ApprovalClaims {
    readonly runId: string
    readonly principalId: string
    readonly tenantId: string
    readonly toolName: string
    readonly inputDigest: string
    readonly now: number
}

export interface ApprovalVerifier {
    /** Must validate and consume a grant atomically; a grant can authorize one call only. */
    consume(grant: ApprovalGrant, claims: ApprovalClaims): Promise<boolean>
}

export type PolicyDecision =
    | { readonly kind: 'allow' }
    | { readonly kind: 'deny'; readonly reason: string }
    | { readonly kind: 'approval_required'; readonly inputDigest: string }

export interface AgentPolicy {
    authorize(input: {
        readonly runId: string
        readonly principal: AgentPrincipal
        readonly tool: AgentTool
        readonly args: JsonValue
        readonly approval?: ApprovalGrant
        readonly now: number
    }): Promise<PolicyDecision>
}

export interface AgentBudget {
    readonly maxSteps: number
    readonly maxToolCalls: number
    readonly maxDurationMs: number
    readonly perOperationTimeoutMs: number
    readonly maxOutputChars: number
}

export interface RunEvent {
    readonly type: RunEventType
    readonly at: number
    readonly step?: number
    readonly toolName?: string
    readonly status?: RunStatus
    readonly detail?: Readonly<Record<string, JsonValue>>
}

export interface RunSnapshot {
    readonly id: string
    readonly tenantId: string
    readonly principalId: string
    readonly status: RunStatus
    readonly version: number
    readonly stepCount: number
    readonly toolCallCount: number
    readonly createdAt: number
    readonly updatedAt: number
    readonly output?: string
    readonly events: readonly RunEvent[]
}

export interface RunStore {
    create(snapshot: RunSnapshot): Promise<void>
    get(id: string, scope: { tenantId: string; principalId: string }): Promise<RunSnapshot | null>
    appendEvent(id: string, event: RunEvent, expectedVersion: number): Promise<RunSnapshot>
    transition(
        id: string,
        next: RunStatus,
        patch: { output?: string; stepCount?: number; toolCallCount?: number },
        expectedVersion: number
    ): Promise<RunSnapshot>
}

export interface TraceSink {
    emit(event: RunEvent, scope: { runId: string; tenantId: string }): Promise<void>
}

export interface AgentRunInput {
    readonly runId: string
    readonly task: string
    readonly principal: AgentPrincipal
    readonly budget?: Partial<AgentBudget>
    readonly approval?: ApprovalGrant
    readonly signal?: AbortSignal
}

export interface AgentRunResult {
    readonly runId: string
    readonly status: RunStatus
    readonly output?: string
    readonly steps: number
    readonly toolCalls: number
    readonly pendingApproval?: {
        readonly toolName: string
        readonly inputDigest: string
    }
}

export interface GoldenCase {
    readonly id: string
    readonly input: AgentRunInput
    readonly expectedStatus: RunStatus
    readonly outputIncludes?: string
    readonly expectedTools?: readonly string[]
    readonly forbiddenTools?: readonly string[]
}

export interface EvaluationFinding {
    readonly caseId: string
    readonly passed: boolean
    readonly message: string
}
