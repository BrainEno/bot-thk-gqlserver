import { createHash } from 'crypto'
import {
    AgentRunInput,
    AgentRunResult,
    GoldenCase,
    JsonValue,
    RunEvent,
    RunStatus,
} from './types'
import {
    CaseEvaluation,
    EvaluationThresholds,
    VersionedEvaluationSuite,
    evaluateGoldenCase,
    hasUnredactedSensitiveDetail,
} from './evaluation'
import { canonicalJson } from './canonicalJson'
import { redactEvent } from './redaction'

const SUITE_ID_PATTERN = /^[a-z][a-z0-9._-]{1,63}$/
const CASE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/
const RUN_ID_PATTERN = /^[A-Za-z0-9_-]{8,96}$/
const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{1,63}$/
const RUN_STATUSES: readonly RunStatus[] = [
    'queued', 'running', 'waiting_for_approval', 'succeeded', 'failed', 'cancelled',
]
const MAX_CASES = 50
const MAX_REPETITIONS = 10
const MAX_TOTAL_RUNS = 500
const MAX_EVENTS_PER_RUN = 4_096
const MAX_FINGERPRINT_TEXT = 32_000
const DEFAULT_THRESHOLDS: EvaluationThresholds = {
    minimumScore: 1,
    maximumFailedCases: 0,
    maximumUnstableCases: 0,
}

export interface EvaluationSuiteIssue {
    readonly path: string
    readonly code: string
}

export interface EvaluationRunOutput {
    readonly result: AgentRunResult
    readonly events: readonly RunEvent[]
}

export type EvaluationExecutor = (
    fixture: GoldenCase,
    repetition: number
) => Promise<EvaluationRunOutput>

export interface EvaluationRepetitionReport {
    readonly repetition: number
    readonly passed: boolean
    readonly findings: readonly string[]
}

export interface EvaluationCaseReport {
    readonly caseId: string
    readonly passed: boolean
    readonly stable: boolean
    readonly repetitions: readonly EvaluationRepetitionReport[]
    readonly findings: readonly string[]
}

export interface EvaluationGateResult {
    readonly passed: boolean
    readonly failures: readonly string[]
    readonly thresholds: EvaluationThresholds
}

export interface VersionedEvaluationReport {
    readonly schemaVersion: 1
    readonly suiteId: string
    readonly startedAt: number
    readonly durationMs: number
    readonly caseCount: number
    readonly repetitionCount: number
    readonly passedCases: number
    readonly failedCases: number
    readonly unstableCases: number
    readonly score: number
    readonly deterministic: boolean
    readonly cases: readonly EvaluationCaseReport[]
    readonly gate: EvaluationGateResult
}

export class EvaluationSuiteValidationError extends Error {
    constructor(readonly issues: readonly EvaluationSuiteIssue[]) {
        super('evaluation suite is invalid')
        this.name = 'EvaluationSuiteValidationError'
    }
}

export class EvaluationGateError extends Error {
    constructor(readonly failures: readonly string[]) {
        super('evaluation quality gate failed')
        this.name = 'EvaluationGateError'
    }
}

export const validateEvaluationSuite = (
    suite: VersionedEvaluationSuite
): readonly EvaluationSuiteIssue[] => {
    const issues: EvaluationSuiteIssue[] = []
    if (!isPlainObject(suite)) return [{ path: '$', code: 'suite_not_object' }]
    if (suite.schemaVersion !== 1) issues.push({ path: 'schemaVersion', code: 'unsupported_version' })
    if (typeof suite.suiteId !== 'string' || !SUITE_ID_PATTERN.test(suite.suiteId)) {
        issues.push({ path: 'suiteId', code: 'invalid_identifier' })
    }
    if (!Array.isArray(suite.cases) || suite.cases.length < 1 || suite.cases.length > MAX_CASES) {
        issues.push({ path: 'cases', code: 'case_count_out_of_range' })
        return issues
    }

    const repetitions = suite.repetitions ?? 1
    if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > MAX_REPETITIONS) {
        issues.push({ path: 'repetitions', code: 'repetition_count_out_of_range' })
    } else if (suite.cases.length * repetitions > MAX_TOTAL_RUNS) {
        issues.push({ path: 'repetitions', code: 'total_execution_count_exceeded' })
    }
    if (suite.deterministic !== undefined && typeof suite.deterministic !== 'boolean') {
        issues.push({ path: 'deterministic', code: 'expected_boolean' })
    }
    validateThresholds(suite.thresholds, issues)

    const caseIds = new Set<string>()
    const runIds = new Set<string>()
    suite.cases.forEach((fixture, index) => {
        validateCase(fixture, `cases[${index}]`, issues)
        if (typeof fixture?.id === 'string') {
            if (caseIds.has(fixture.id)) issues.push({ path: `cases[${index}].id`, code: 'duplicate_case_id' })
            caseIds.add(fixture.id)
        }
        const runId = fixture?.input?.runId
        if (typeof runId === 'string') {
            if (runIds.has(runId)) issues.push({ path: `cases[${index}].input.runId`, code: 'duplicate_run_id' })
            runIds.add(runId)
        }
    })
    return issues
}

export const runVersionedEvaluationSuite = async (
    suite: VersionedEvaluationSuite,
    execute: EvaluationExecutor,
    clock: () => number = Date.now
): Promise<VersionedEvaluationReport> => {
    const issues = validateEvaluationSuite(suite)
    if (issues.length > 0) throw new EvaluationSuiteValidationError(issues)

    const startedAt = finiteTime(clock())
    const repetitions = suite.repetitions ?? 1
    const deterministic = suite.deterministic ?? true
    const caseReports: EvaluationCaseReport[] = []

    for (const fixture of suite.cases) {
        const repetitionReports: EvaluationRepetitionReport[] = []
        const fingerprints: Array<string | null> = []
        for (let repetition = 0; repetition < repetitions; repetition += 1) {
            let evaluation: CaseEvaluation
            let fingerprint: string | null = null
            try {
                const output = await execute(cloneFixture(fixture), repetition)
                if (!isEvaluationRunOutput(output)) {
                    evaluation = failedEvaluation(fixture.id, 'evaluation output was invalid')
                } else if (output.events.length > MAX_EVENTS_PER_RUN) {
                    evaluation = failedEvaluation(fixture.id, 'event count exceeded the evaluation limit')
                } else {
                    evaluation = evaluateGoldenCase(fixture, output.result, output.events)
                    fingerprint = createFingerprint(output)
                }
            } catch {
                // Do not leak thrown error messages into artifacts; they may contain secrets.
                evaluation = failedEvaluation(fixture.id, 'evaluation execution failed')
            }
            fingerprints.push(fingerprint)
            repetitionReports.push({
                repetition,
                passed: evaluation.passed,
                findings: evaluation.findings,
            })
        }

        const stable = fingerprints.length <= 1 || fingerprints.every(
            (fingerprint) => fingerprint !== null && fingerprint === fingerprints[0]
        )
        const findings = uniqueStrings(repetitionReports.flatMap((entry) => entry.findings))
        if (deterministic && !stable) findings.push('repeated executions were not deterministic')
        const passed = repetitionReports.every((entry) => entry.passed) && (!deterministic || stable)
        caseReports.push({
            caseId: fixture.id,
            passed,
            stable,
            repetitions: repetitionReports,
            findings,
        })
    }

    const finishedAt = finiteTime(clock())
    const passedCases = caseReports.filter((item) => item.passed).length
    const failedCases = caseReports.length - passedCases
    const unstableCases = caseReports.filter((item) => !item.stable).length
    const score = caseReports.length === 0 ? 1 : passedCases / caseReports.length
    const thresholds = normalizeThresholds(suite.thresholds)
    const gate = evaluateGate({ score, failedCases, unstableCases, deterministic, thresholds })

    return {
        schemaVersion: 1,
        suiteId: suite.suiteId,
        startedAt,
        durationMs: Math.max(0, finishedAt - startedAt),
        caseCount: caseReports.length,
        repetitionCount: repetitions,
        passedCases,
        failedCases,
        unstableCases,
        score,
        deterministic,
        cases: caseReports,
        gate,
    }
}

export const assertEvaluationGate = (report: VersionedEvaluationReport): void => {
    if (!report.gate.passed) throw new EvaluationGateError(report.gate.failures)
}

export const normalizeEvaluationThresholds = (
    thresholds?: Partial<EvaluationThresholds>
): EvaluationThresholds => normalizeThresholds(thresholds)

const validateCase = (
    fixture: GoldenCase,
    path: string,
    issues: EvaluationSuiteIssue[]
): void => {
    if (!isPlainObject(fixture)) {
        issues.push({ path, code: 'case_not_object' })
        return
    }
    if (typeof fixture.id !== 'string' || !CASE_ID_PATTERN.test(fixture.id)) {
        issues.push({ path: `${path}.id`, code: 'invalid_identifier' })
    }
    if (!RUN_STATUSES.includes(fixture.expectedStatus)) {
        issues.push({ path: `${path}.expectedStatus`, code: 'invalid_run_status' })
    }
    const input = fixture.input
    if (!isPlainObject(input)) {
        issues.push({ path: `${path}.input`, code: 'input_not_object' })
        return
    }
    if (typeof input.runId !== 'string' || !RUN_ID_PATTERN.test(input.runId)) {
        issues.push({ path: `${path}.input.runId`, code: 'invalid_identifier' })
    }
    if (typeof input.task !== 'string' || input.task.trim().length === 0 || input.task.length > 16_000) {
        issues.push({ path: `${path}.input.task`, code: 'task_length_out_of_range' })
    }
    if (input.signal !== undefined) issues.push({ path: `${path}.input.signal`, code: 'signals_not_allowed_in_fixtures' })
    if (!isPlainObject(input.principal) || !isIdentity(input.principal.id) || !isIdentity(input.principal.tenantId)) {
        issues.push({ path: `${path}.input.principal`, code: 'invalid_principal' })
    } else if (
        !Array.isArray(input.principal.permissions) ||
        input.principal.permissions.length > 128 ||
        input.principal.permissions.some((permission) => !isPermission(permission))
    ) {
        issues.push({ path: `${path}.input.principal.permissions`, code: 'invalid_permissions' })
    }
    if (input.budget !== undefined && !isBoundedBudget(input.budget)) {
        issues.push({ path: `${path}.input.budget`, code: 'invalid_budget' })
    }
    if (input.approval !== undefined && !isScopedApproval(input.approval, input)) {
        issues.push({ path: `${path}.input.approval`, code: 'approval_scope_mismatch' })
    }

    validateToolList(fixture.expectedTools, `${path}.expectedTools`, issues)
    validateToolList(fixture.expectedToolSequence, `${path}.expectedToolSequence`, issues, false)
    validateToolList(fixture.forbiddenTools, `${path}.forbiddenTools`, issues)
    validateEventList(fixture.requiredEventTypes, `${path}.requiredEventTypes`, issues)
    validateEventList(fixture.forbiddenEventTypes, `${path}.forbiddenEventTypes`, issues)
    if (intersects(fixture.expectedTools, fixture.forbiddenTools) ||
        intersects(fixture.expectedToolSequence, fixture.forbiddenTools)) {
        issues.push({ path: `${path}.forbiddenTools`, code: 'conflicting_tool_expectations' })
    }
    if (intersects(fixture.requiredEventTypes, fixture.forbiddenEventTypes)) {
        issues.push({ path: `${path}.forbiddenEventTypes`, code: 'conflicting_event_expectations' })
    }
    if (
        fixture.outputIncludes !== undefined &&
        (typeof fixture.outputIncludes !== 'string' || fixture.outputIncludes.length > MAX_FINGERPRINT_TEXT)
    ) issues.push({ path: `${path}.outputIncludes`, code: 'output_assertion_too_long' })
    if (
        fixture.expectedPendingApprovalTool !== undefined &&
        fixture.expectedPendingApprovalTool !== null &&
        !isToolName(fixture.expectedPendingApprovalTool)
    ) issues.push({ path: `${path}.expectedPendingApprovalTool`, code: 'invalid_tool_name' })
    validateCounterBounds(fixture.minSteps, fixture.maxSteps, `${path}.steps`, issues, 20)
    validateCounterBounds(fixture.minToolCalls, fixture.maxToolCalls, `${path}.toolCalls`, issues, 10)
}

const validateThresholds = (
    thresholds: Partial<EvaluationThresholds> | undefined,
    issues: EvaluationSuiteIssue[]
): void => {
    if (thresholds === undefined) return
    if (!isPlainObject(thresholds)) {
        issues.push({ path: 'thresholds', code: 'thresholds_not_object' })
        return
    }
    const merged = { ...DEFAULT_THRESHOLDS, ...thresholds }
    if (typeof merged.minimumScore !== 'number' || !Number.isFinite(merged.minimumScore) ||
        merged.minimumScore < 0 || merged.minimumScore > 1) {
        issues.push({ path: 'thresholds.minimumScore', code: 'score_threshold_out_of_range' })
    }
    for (const key of ['maximumFailedCases', 'maximumUnstableCases'] as const) {
        if (!Number.isInteger(merged[key]) || merged[key] < 0 || merged[key] > MAX_CASES) {
            issues.push({ path: `thresholds.${key}`, code: 'count_threshold_out_of_range' })
        }
    }
}

const normalizeThresholds = (
    thresholds?: Partial<EvaluationThresholds>
): EvaluationThresholds => ({
    ...DEFAULT_THRESHOLDS,
    ...thresholds,
})

const validateToolList = (
    list: readonly string[] | undefined,
    path: string,
    issues: EvaluationSuiteIssue[],
    unique = true
): void => {
    if (list === undefined) return
    if (!Array.isArray(list) || list.length > 64 || list.some((item) => typeof item !== 'string')) {
        issues.push({ path, code: 'invalid_list' })
        return
    }
    const seen = new Set<string>()
    list.forEach((name, index) => {
        if (!isToolName(name)) issues.push({ path: `${path}[${index}]`, code: 'invalid_tool_name' })
        if (unique && seen.has(name)) issues.push({ path: `${path}[${index}]`, code: 'duplicate_tool_name' })
        seen.add(name)
    })
}

const validateEventList = (
    list: readonly string[] | undefined,
    path: string,
    issues: EvaluationSuiteIssue[]
): void => {
    if (list === undefined) return
    if (!Array.isArray(list) || list.length > 64 || list.some((item) => typeof item !== 'string')) {
        issues.push({ path, code: 'invalid_list' })
        return
    }
    const seen = new Set<string>()
    list.forEach((type, index) => {
        if (!isEventType(type)) issues.push({ path: `${path}[${index}]`, code: 'invalid_event_type' })
        if (seen.has(type)) issues.push({ path: `${path}[${index}]`, code: 'duplicate_event_type' })
        seen.add(type)
    })
}

const validateCounterBounds = (
    min: number | undefined,
    max: number | undefined,
    path: string,
    issues: EvaluationSuiteIssue[],
    maximum: number
): void => {
    if (min !== undefined && (!Number.isInteger(min) || min < 0 || min > maximum)) {
        issues.push({ path: `min${path}`, code: 'counter_out_of_range' })
    }
    if (max !== undefined && (!Number.isInteger(max) || max < 0 || max > maximum)) {
        issues.push({ path: `max${path}`, code: 'counter_out_of_range' })
    }
    if (min !== undefined && max !== undefined && min > max) {
        issues.push({ path, code: 'counter_bounds_inverted' })
    }
}

const isBoundedBudget = (budget: AgentRunInput['budget']): boolean => {
    if (!isPlainObject(budget)) return false
    const values = Object.values(budget)
    if (values.length > 5) return false
    const max: Readonly<Record<string, number>> = {
        maxSteps: 20,
        maxToolCalls: 10,
        maxDurationMs: 120_000,
        perOperationTimeoutMs: 30_000,
        maxOutputChars: 32_000,
    }
    const allFieldsBounded = Object.entries(budget).every(([key, value]) =>
        key in max && Number.isInteger(value) && typeof value === 'number' && value > 0 && value <= max[key]
    )
    const durationIsConsistent = budget.perOperationTimeoutMs === undefined ||
        budget.maxDurationMs === undefined ||
        budget.perOperationTimeoutMs <= budget.maxDurationMs
    return allFieldsBounded && durationIsConsistent
}

const isScopedApproval = (
    approval: NonNullable<AgentRunInput['approval']>,
    input: AgentRunInput
): boolean =>
    isPlainObject(approval) &&
    typeof approval.id === 'string' &&
    APPROVAL_ID_PATTERN.test(approval.id) &&
    approval.runId === input.runId &&
    approval.principalId === input.principal?.id &&
    approval.tenantId === input.principal?.tenantId &&
    isToolName(approval.toolName) &&
    /^[a-f0-9]{64}$/.test(approval.inputDigest) &&
    Number.isFinite(approval.expiresAt)

const APPROVAL_ID_PATTERN = /^[A-Za-z0-9_-]{22,128}$/

const isIdentity = (value: unknown): value is string =>
    typeof value === 'string' && value.trim().length > 0 && value.length <= 128

const isPermission = (value: unknown): boolean =>
    typeof value === 'string' && /^[a-z][a-z0-9_]{1,63}$/.test(value)

const isToolName = (value: unknown): boolean =>
    typeof value === 'string' && TOOL_NAME_PATTERN.test(value)

const isEventType = (value: string): boolean =>
    [
        'run_created', 'run_started', 'model_step_started', 'tool_call_requested', 'tool_call_denied',
        'approval_required', 'approval_resumed', 'approval_rejected', 'approval_expired', 'run_resumed',
        'tool_call_started', 'tool_call_succeeded', 'tool_call_failed', 'run_succeeded', 'run_failed',
        'run_cancelled',
    ].includes(value)

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype

const cloneFixture = (fixture: GoldenCase): GoldenCase => ({
    ...fixture,
    input: {
        runId: fixture.input.runId,
        task: fixture.input.task,
        principal: {
            ...fixture.input.principal,
            permissions: [...fixture.input.principal.permissions],
        },
        budget: fixture.input.budget ? { ...fixture.input.budget } : undefined,
        approval: fixture.input.approval ? { ...fixture.input.approval } : undefined,
    },
    expectedTools: fixture.expectedTools ? [...fixture.expectedTools] : undefined,
    expectedToolSequence: fixture.expectedToolSequence ? [...fixture.expectedToolSequence] : undefined,
    forbiddenTools: fixture.forbiddenTools ? [...fixture.forbiddenTools] : undefined,
    requiredEventTypes: fixture.requiredEventTypes ? [...fixture.requiredEventTypes] : undefined,
    forbiddenEventTypes: fixture.forbiddenEventTypes ? [...fixture.forbiddenEventTypes] : undefined,
})

const isEvaluationRunOutput = (value: unknown): value is EvaluationRunOutput => {
    if (!isPlainObject(value) || !isPlainObject(value.result) || !Array.isArray(value.events)) return false
    const result = value.result
    if (
        typeof result.runId !== 'string' ||
        !RUN_STATUSES.includes(result.status as RunStatus) ||
        typeof result.steps !== 'number' ||
        typeof result.toolCalls !== 'number' ||
        (result.output !== undefined && typeof result.output !== 'string')
    ) return false
    return value.events.every((event) =>
        isPlainObject(event) &&
        typeof event.type === 'string' &&
        Number.isFinite(event.at)
    )
}

const createFingerprint = (output: EvaluationRunOutput): string | null => {
    try {
        if (
            output.result.runId.length > 96 ||
            (output.result.output !== undefined && output.result.output.length > MAX_FINGERPRINT_TEXT) ||
            output.events.length > MAX_EVENTS_PER_RUN ||
            output.events.some((event) => hasUnredactedSensitiveDetail(event))
        ) return null
        const events = output.events.map((event) => {
            const safe = redactEvent(event)
            return {
                type: safe.type,
                step: safe.step ?? null,
                toolName: safe.toolName ?? null,
                status: safe.status ?? null,
                detail: safe.detail ? normalizeTranscriptDetail(safe.detail) : null,
            }
        })
        const transcript = {
            result: {
                runId: output.result.runId,
                status: output.result.status,
                output: output.result.output ?? null,
                steps: output.result.steps,
                toolCalls: output.result.toolCalls,
                pendingApproval: output.result.pendingApproval
                    ? {
                        toolName: output.result.pendingApproval.toolName,
                        inputDigest: output.result.pendingApproval.inputDigest,
                    }
                    : null,
            },
            events,
        }
        return createHash('sha256').update(canonicalJson(transcript as JsonValue)).digest('hex')
    } catch {
        return null
    }
}

const normalizeTranscriptDetail = (value: JsonValue): JsonValue => {
    if (value === null || typeof value !== 'object') return value
    if (Array.isArray(value)) return value.map(normalizeTranscriptDetail)
    const normalized: Record<string, JsonValue> = {}
    for (const [key, child] of Object.entries(value)) {
        if (key === 'approvalId' || key === 'expiresAt') continue
        Object.defineProperty(normalized, key, {
            value: normalizeTranscriptDetail(child),
            enumerable: true,
            configurable: true,
            writable: true,
        })
    }
    return normalized
}

const evaluateGate = (input: {
    readonly score: number
    readonly failedCases: number
    readonly unstableCases: number
    readonly deterministic: boolean
    readonly thresholds: EvaluationThresholds
}): EvaluationGateResult => {
    const failures: string[] = []
    if (input.score < input.thresholds.minimumScore) failures.push('minimum score threshold was not met')
    if (input.failedCases > input.thresholds.maximumFailedCases) failures.push('maximum failed-case threshold was exceeded')
    if (input.deterministic && input.unstableCases > input.thresholds.maximumUnstableCases) {
        failures.push('maximum unstable-case threshold was exceeded')
    }
    return { passed: failures.length === 0, failures, thresholds: input.thresholds }
}

const failedEvaluation = (caseId: string, finding: string): CaseEvaluation => ({
    caseId,
    passed: false,
    findings: [finding],
})

const uniqueStrings = (values: readonly string[]): string[] => [...new Set(values)]

const intersects = (left: readonly string[] | undefined, right: readonly string[] | undefined): boolean => {
    if (!Array.isArray(left) || !Array.isArray(right)) return false
    const candidates = new Set(left)
    return right.some((value) => candidates.has(value))
}

const finiteTime = (value: number): number => Number.isFinite(value) ? value : 0
