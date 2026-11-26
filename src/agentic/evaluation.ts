import { AgentRunResult, GoldenCase, RunEvent, RunEventType } from './types'
import { canonicalJson } from './canonicalJson'
import { redactEvent } from './redaction'

export interface CaseEvaluation {
    readonly caseId: string
    readonly passed: boolean
    readonly findings: readonly string[]
}

export interface SuiteEvaluation {
    readonly total: number
    readonly passed: number
    readonly failed: number
    readonly score: number
    readonly cases: readonly CaseEvaluation[]
}

export interface EvaluationThresholds {
    readonly minimumScore: number
    readonly maximumFailedCases: number
    readonly maximumUnstableCases: number
}

export interface VersionedEvaluationSuite {
    readonly schemaVersion: 1
    readonly suiteId: string
    readonly cases: readonly GoldenCase[]
    readonly repetitions?: number
    readonly deterministic?: boolean
    readonly thresholds?: Partial<EvaluationThresholds>
}

export const evaluateGoldenCase = (
    fixture: GoldenCase,
    result: AgentRunResult,
    events: readonly RunEvent[]
): CaseEvaluation => {
    const findings: string[] = []
    if (result.runId !== fixture.input.runId) findings.push('result run id did not match the fixture')
    if (result.status !== fixture.expectedStatus) {
        findings.push(`expected status ${fixture.expectedStatus}, got ${result.status}`)
    }
    if (!isNonNegativeInteger(result.steps) || !isNonNegativeInteger(result.toolCalls)) {
        findings.push('result counters were invalid')
    } else if (result.toolCalls > result.steps) {
        findings.push('tool call count exceeded the number of model steps')
    }
    if (fixture.minSteps !== undefined && result.steps < fixture.minSteps) {
        findings.push('minimum step count was not met')
    }
    if (fixture.maxSteps !== undefined && result.steps > fixture.maxSteps) {
        findings.push('maximum step count was exceeded')
    }
    if (fixture.minToolCalls !== undefined && result.toolCalls < fixture.minToolCalls) {
        findings.push('minimum tool call count was not met')
    }
    if (fixture.maxToolCalls !== undefined && result.toolCalls > fixture.maxToolCalls) {
        findings.push('maximum tool call count was exceeded')
    }
    if (fixture.outputIncludes && !result.output?.includes(fixture.outputIncludes)) {
        findings.push('expected output fragment was not present')
    }
    if (fixture.expectedPendingApprovalTool !== undefined) {
        const pendingTool = result.pendingApproval?.toolName ?? null
        if (pendingTool !== fixture.expectedPendingApprovalTool) {
            findings.push('pending approval tool did not match the expected value')
        }
    }

    const toolNames = events
        .filter((event) => event.type === 'tool_call_started' && event.toolName)
        .map((event) => event.toolName as string)
    for (const expected of fixture.expectedTools ?? []) {
        if (!toolNames.includes(expected)) findings.push(`expected tool was not called: ${expected}`)
    }
    for (const forbidden of fixture.forbiddenTools ?? []) {
        if (toolNames.includes(forbidden)) findings.push(`forbidden tool was called: ${forbidden}`)
    }
    if (fixture.expectedToolSequence && !sameStrings(toolNames, fixture.expectedToolSequence)) {
        findings.push('tool call order did not match the expected sequence')
    }
    const eventTypes = new Set(events.map((event) => event.type))
    for (const required of fixture.requiredEventTypes ?? []) {
        if (!eventTypes.has(required)) findings.push(`required event was absent: ${required}`)
    }
    for (const forbidden of fixture.forbiddenEventTypes ?? []) {
        if (eventTypes.has(forbidden)) findings.push(`forbidden event was present: ${forbidden}`)
    }
    if (events.some(hasUnredactedSensitiveDetail)) {
        findings.push('event privacy check failed')
    }

    return {
        caseId: fixture.id,
        passed: findings.length === 0,
        findings,
    }
}

export const summarizeEvaluation = (
    results: readonly CaseEvaluation[]
): SuiteEvaluation => {
    const passed = results.filter((item) => item.passed).length
    return {
        total: results.length,
        passed,
        failed: results.length - passed,
        score: results.length === 0 ? 1 : passed / results.length,
        cases: results,
    }
}

/** Sequential by design: fixtures must not share run IDs or mutate shared tools. */
export const runEvaluationSuite = async (
    fixtures: readonly GoldenCase[],
    execute: (fixture: GoldenCase) => Promise<{
        result: AgentRunResult
        events: readonly RunEvent[]
    }>
): Promise<SuiteEvaluation> => {
    const evaluations: CaseEvaluation[] = []
    for (const fixture of fixtures) {
        try {
            const { result, events } = await execute(fixture)
            evaluations.push(evaluateGoldenCase(fixture, result, events))
        } catch {
            // Never copy thrown provider/tool errors into the report; they can contain secrets.
            evaluations.push({
                caseId: fixture.id,
                passed: false,
                findings: ['evaluation execution failed'],
            })
        }
    }
    return summarizeEvaluation(evaluations)
}

export const EVENT_TYPES: readonly RunEventType[] = [
    'run_created',
    'run_started',
    'model_step_started',
    'tool_call_requested',
    'tool_call_denied',
    'approval_required',
    'approval_resumed',
    'approval_rejected',
    'approval_expired',
    'run_resumed',
    'tool_call_started',
    'tool_call_succeeded',
    'tool_call_failed',
    'run_succeeded',
    'run_failed',
    'run_cancelled',
]

export const hasUnredactedSensitiveDetail = (event: RunEvent): boolean => {
    try {
        if (!event.detail) return false
        return canonicalJson(event.detail) !== canonicalJson(redactEvent(event).detail)
    } catch {
        return true
    }
}

const isNonNegativeInteger = (value: number): boolean =>
    Number.isInteger(value) && value >= 0

const sameStrings = (left: readonly string[], right: readonly string[]): boolean =>
    left.length === right.length && left.every((value, index) => value === right[index])
