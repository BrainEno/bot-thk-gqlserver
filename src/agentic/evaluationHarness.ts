import { AgentRuntime } from './runtime'
import { ScriptedFakeProvider } from './fakeProvider'
import { PermissionPolicy } from './policy'
import { InMemoryRunStore } from './runStore'
import { MemoryTraceWriter, RedactingTraceSink } from './trace'
import { ToolRegistry } from './toolRegistry'
import {
    AgentPrincipal,
    AgentRunInput,
    AgentTool,
    ModelDecision,
} from './types'
import {
    AgentRuntimeEvaluationContext,
    AgentRuntimeEvaluationSession,
} from './runtimeEvaluationAdapter'

/** A scenario is deliberately composed from deterministic model and local tools. */
export interface IsolatedEvaluationScenario {
    readonly decisions: readonly ModelDecision[]
    readonly tools: readonly AgentTool[]
    readonly clock?: () => number
}

/**
 * The optional instrumentation is useful to assert isolation in tests and CI.
 * None of these collaborators are connected to the GraphQL server or its
 * production service container.
 */
export interface IsolatedEvaluationSession extends AgentRuntimeEvaluationSession {
    readonly provider: ScriptedFakeProvider
    readonly store: InMemoryRunStore
    readonly registry: ToolRegistry
    readonly traceWriter: MemoryTraceWriter
}

export type IsolatedEvaluationScenarioResolver = (
    input: AgentRunInput,
    context: AgentRuntimeEvaluationContext
) => IsolatedEvaluationScenario | Promise<IsolatedEvaluationScenario>

export type IsolatedEvaluationFactory = (
    input: AgentRunInput,
    context: AgentRuntimeEvaluationContext
) => Promise<IsolatedEvaluationSession>

export class EvaluationHarnessConfigurationError extends Error {
    constructor(readonly code: EvaluationHarnessConfigurationErrorCode) {
        super('isolated evaluation scenario is invalid')
        this.name = 'EvaluationHarnessConfigurationError'
    }
}

export type EvaluationHarnessConfigurationErrorCode =
    | 'invalid_scenario'
    | 'invalid_decisions'
    | 'invalid_tool_list'
    | 'invalid_clock'
    | 'duplicate_tool'

/**
 * Create a fresh in-memory runtime for one evaluation repetition. The scenario
 * resolver is invoked for each call, so callers can use the case id and
 * repetition number to choose scripts without sharing run state.
 */
export const createIsolatedEvaluationFactory = (
    resolveScenario: IsolatedEvaluationScenarioResolver
): IsolatedEvaluationFactory => async (input, context) => {
    if (typeof resolveScenario !== 'function') {
        throw new EvaluationHarnessConfigurationError('invalid_scenario')
    }
    const scenario = await resolveScenario(cloneInput(input), { ...context })
    assertScenario(scenario)

    const provider = new ScriptedFakeProvider(cloneDecisions(scenario.decisions))
    const registry = new ToolRegistry()
    const toolNames = new Set<string>()
    for (const tool of scenario.tools) {
        if (toolNames.has(tool.name)) {
            throw new EvaluationHarnessConfigurationError('duplicate_tool')
        }
        toolNames.add(tool.name)
        registry.register(tool)
    }

    const store = new InMemoryRunStore(scenario.clock)
    const traceWriter = new MemoryTraceWriter()
    const runtime = new AgentRuntime(
        provider,
        registry,
        new PermissionPolicy(),
        store,
        new RedactingTraceSink(traceWriter),
        scenario.clock
    )
    return { runtime, store, provider, registry, traceWriter }
}

/** Build an isolated session directly when a caller does not need a factory. */
export const createIsolatedEvaluationSession = async (
    input: AgentRunInput,
    scenario: IsolatedEvaluationScenario
): Promise<IsolatedEvaluationSession> => {
    const factory = createIsolatedEvaluationFactory(() => scenario)
    return factory(input, { caseId: 'direct-evaluation', repetition: 0 })
}

const assertScenario = (value: IsolatedEvaluationScenario): void => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new EvaluationHarnessConfigurationError('invalid_scenario')
    }
    if (!Array.isArray(value.decisions) || value.decisions.length === 0) {
        throw new EvaluationHarnessConfigurationError('invalid_decisions')
    }
    if (value.decisions.some((decision) => !isModelDecision(decision))) {
        throw new EvaluationHarnessConfigurationError('invalid_decisions')
    }
    if (!Array.isArray(value.tools) || value.tools.some((tool) => !isLocalToolShape(tool))) {
        throw new EvaluationHarnessConfigurationError('invalid_tool_list')
    }
    if (value.clock !== undefined && typeof value.clock !== 'function') {
        throw new EvaluationHarnessConfigurationError('invalid_clock')
    }
}

const isModelDecision = (value: ModelDecision): boolean => {
    if (!value || typeof value !== 'object') return false
    if (value.kind === 'final') return typeof value.output === 'string'
    return value.kind === 'tool_call' &&
        typeof value.callId === 'string' &&
        typeof value.name === 'string'
}

const isLocalToolShape = (value: AgentTool): boolean => Boolean(
    value &&
    typeof value === 'object' &&
    typeof value.name === 'string' &&
    typeof value.execute === 'function'
)

const cloneInput = (input: AgentRunInput): AgentRunInput => ({
    runId: input.runId,
    task: input.task,
    principal: clonePrincipal(input.principal),
    budget: input.budget ? { ...input.budget } : undefined,
    approval: input.approval ? { ...input.approval } : undefined,
})

const clonePrincipal = (principal: AgentPrincipal): AgentPrincipal => ({
    id: principal.id,
    tenantId: principal.tenantId,
    permissions: [...principal.permissions],
})

const cloneDecisions = (decisions: readonly ModelDecision[]): readonly ModelDecision[] =>
    decisions.map((decision) => decision.kind === 'final'
        ? { kind: 'final', output: decision.output }
        : {
            kind: 'tool_call',
            callId: decision.callId,
            name: decision.name,
            input: cloneUnknownJson(decision.input),
        })

const cloneUnknownJson = (value: unknown): unknown => {
    if (value === null || typeof value !== 'object') return value
    if (Array.isArray(value)) return value.map(cloneUnknownJson)
    if (Object.getPrototypeOf(value) !== Object.prototype) return '[NON_PLAIN_OBJECT]'
    const output: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>)) {
        Object.defineProperty(output, key, {
            value: cloneUnknownJson((value as Record<string, unknown>)[key]),
            enumerable: true,
            configurable: true,
            writable: true,
        })
    }
    return output
}
