import { AgentRunInput, AgentRunResult, GoldenCase, JsonValue, RunEvent, RunStore } from './types'
import { AgentRuntime } from './runtime'
import { EvaluationExecutor } from './evaluationRunner'

export interface AgentRuntimeEvaluationSession {
    readonly runtime: Pick<AgentRuntime, 'run'>
    readonly store: RunStore
}

export interface AgentRuntimeEvaluationContext {
    readonly caseId: string
    readonly repetition: number
}

export type AgentRuntimeEvaluationFactory = (
    input: AgentRunInput,
    context: AgentRuntimeEvaluationContext
) => AgentRuntimeEvaluationSession | Promise<AgentRuntimeEvaluationSession>

export type AgentRuntimeEvaluationErrorCode =
    | 'invalid_factory_session'
    | 'run_id_mismatch'
    | 'run_snapshot_missing'
    | 'run_snapshot_mismatch'

export class AgentRuntimeEvaluationError extends Error {
    constructor(readonly code: AgentRuntimeEvaluationErrorCode) {
        super('isolated runtime evaluation could not capture a consistent run')
        this.name = 'AgentRuntimeEvaluationError'
    }
}

/**
 * Adapt the real runtime/store interfaces to an evaluation executor. Supply a
 * fresh in-memory runtime with a scripted fake provider for every repetition;
 * this adapter intentionally does not construct providers or production tools.
 */
export const createAgentRuntimeEvaluationExecutor = (
    createSession: AgentRuntimeEvaluationFactory
): EvaluationExecutor => async (fixture: GoldenCase, repetition: number) => {
    const input = cloneRunInput(fixture.input)
    const session = await createSession(cloneRunInput(input), { caseId: fixture.id, repetition })
    if (!isEvaluationSession(session)) throw new AgentRuntimeEvaluationError('invalid_factory_session')

    const result = await session.runtime.run(input)
    if (!result || result.runId !== input.runId) {
        throw new AgentRuntimeEvaluationError('run_id_mismatch')
    }
    const snapshot = await session.store.get(result.runId, {
        tenantId: input.principal.tenantId,
        principalId: input.principal.id,
    })
    if (!snapshot) throw new AgentRuntimeEvaluationError('run_snapshot_missing')
    if (!matchesRunResult(snapshot, result, input)) {
        throw new AgentRuntimeEvaluationError('run_snapshot_mismatch')
    }
    return { result: cloneRunResult(result), events: snapshot.events.map(cloneEvent) }
}

const cloneRunInput = (input: AgentRunInput): AgentRunInput => ({
    runId: input.runId,
    task: input.task,
    principal: {
        id: input.principal.id,
        tenantId: input.principal.tenantId,
        permissions: [...input.principal.permissions],
    },
    ...(input.budget ? { budget: { ...input.budget } } : {}),
    ...(input.approval ? { approval: { ...input.approval } } : {}),
})

const cloneRunResult = (result: AgentRunResult): AgentRunResult => ({
    runId: result.runId,
    status: result.status,
    output: result.output,
    steps: result.steps,
    toolCalls: result.toolCalls,
    ...(result.pendingApproval ? { pendingApproval: { ...result.pendingApproval } } : {}),
})

const cloneEvent = (event: RunEvent): RunEvent => ({
    ...event,
    ...(event.detail ? { detail: cloneDetail(event.detail) } : {}),
})

const cloneDetail = (
    detail: Readonly<Record<string, JsonValue>>
): Readonly<Record<string, JsonValue>> => {
    const clone: Record<string, JsonValue> = {}
    for (const [key, value] of Object.entries(detail)) {
        Object.defineProperty(clone, key, {
            value: cloneJson(value),
            enumerable: true,
            configurable: true,
            writable: true,
        })
    }
    return clone
}

const cloneJson = (value: JsonValue): JsonValue => {
    if (value === null || typeof value !== 'object') return value
    if (Array.isArray(value)) return value.map(cloneJson)
    return cloneDetail(value)
}

const isEvaluationSession = (value: AgentRuntimeEvaluationSession): boolean =>
    Boolean(
        value &&
            value.runtime &&
            typeof value.runtime.run === 'function' &&
            value.store &&
            typeof value.store.get === 'function'
    )

const matchesRunResult = (
    snapshot: NonNullable<Awaited<ReturnType<RunStore['get']>>>,
    result: AgentRunResult,
    input: AgentRunInput
): boolean =>
    snapshot.id === input.runId &&
    snapshot.tenantId === input.principal.tenantId &&
    snapshot.principalId === input.principal.id &&
    snapshot.status === result.status &&
    snapshot.stepCount === result.steps &&
    snapshot.toolCallCount === result.toolCalls &&
    snapshot.output === result.output &&
    snapshot.pendingApproval?.id === result.pendingApproval?.id &&
    snapshot.pendingApproval?.toolName === result.pendingApproval?.toolName &&
    snapshot.pendingApproval?.inputDigest === result.pendingApproval?.inputDigest &&
    snapshot.pendingApproval?.expiresAt === result.pendingApproval?.expiresAt
