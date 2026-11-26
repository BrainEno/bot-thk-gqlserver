import assert from 'node:assert/strict'
import test from 'node:test'
import {
    AgentRunInput,
    AgentRunResult,
    EvaluationGateError,
    EvaluationSuiteValidationError,
    GoldenCase,
    RunEvent,
    VersionedEvaluationSuite,
    assertEvaluationGate,
    evaluateGoldenCase,
    runVersionedEvaluationSuite,
    validateEvaluationSuite,
} from '../src/agentic'

const makeCase = (overrides: Partial<GoldenCase> = {}): GoldenCase => ({
    id: 'safe-read-case',
    input: {
        runId: 'run-evaluation-0001',
        task: 'Read a bounded public record.',
        principal: {
            id: 'reviewer-17',
            tenantId: 'tenant-eval',
            permissions: ['records_read'],
        },
        budget: {
            maxSteps: 4,
            maxToolCalls: 2,
            maxDurationMs: 10_000,
            perOperationTimeoutMs: 2_000,
            maxOutputChars: 2_000,
        },
    },
    expectedStatus: 'succeeded',
    expectedTools: ['read_record'],
    requiredEventTypes: ['run_succeeded'],
    minSteps: 1,
    maxSteps: 4,
    minToolCalls: 1,
    maxToolCalls: 2,
    ...overrides,
})

const makeSuite = (
    fixture: GoldenCase = makeCase(),
    overrides: Partial<VersionedEvaluationSuite> = {}
): VersionedEvaluationSuite => ({
    schemaVersion: 1,
    suiteId: 'agentic.safe-eval.v1',
    cases: [fixture],
    repetitions: 1,
    deterministic: true,
    thresholds: {
        minimumScore: 1,
        maximumFailedCases: 0,
        maximumUnstableCases: 0,
    },
    ...overrides,
})

const makeResult = (
    fixture: GoldenCase = makeCase(),
    overrides: Partial<AgentRunResult> = {}
): AgentRunResult => ({
    runId: fixture.input.runId,
    status: 'succeeded',
    output: 'Public record value is bounded.',
    steps: 2,
    toolCalls: 1,
    ...overrides,
})

const makeEvents = (at = 10): readonly RunEvent[] => [
    { type: 'model_step_started', at, step: 1 },
    { type: 'tool_call_started', at: at + 1, step: 1, toolName: 'read_record' },
    { type: 'tool_call_succeeded', at: at + 2, toolName: 'read_record' },
    { type: 'run_succeeded', at: at + 3, status: 'succeeded' },
]

const makeOutput = (
    fixture: GoldenCase,
    resultOverrides: Partial<AgentRunResult> = {},
    events: readonly RunEvent[] = makeEvents()
) => ({ result: makeResult(fixture, resultOverrides), events })

const runFixture = async (
    suite: VersionedEvaluationSuite,
    execute: Parameters<typeof runVersionedEvaluationSuite>[1],
    times: readonly number[] = [1_000, 1_010]
) => {
    let cursor = 0
    return runVersionedEvaluationSuite(suite, execute, () => {
        const next = times[Math.min(cursor, times.length - 1)]
        cursor += 1
        return next
    })
}

test('versioned suite validator accepts bounded deterministic fixture contracts', () => {
    assert.deepEqual(validateEvaluationSuite(makeSuite()), [])
})

test('golden evaluation checks output, counters, tool order, events, and pending approval', () => {
    const fixture = makeCase({
        outputIncludes: 'bounded',
        expectedToolSequence: ['read_record', 'read_record'],
        expectedTools: ['read_record'],
        requiredEventTypes: ['run_succeeded', 'tool_call_started'],
        forbiddenEventTypes: ['approval_rejected'],
        expectedPendingApprovalTool: null,
        minSteps: 2,
        maxSteps: 3,
        minToolCalls: 2,
        maxToolCalls: 2,
    })
    const repeatedEvents: RunEvent[] = [
        ...makeEvents(),
        { type: 'tool_call_started', at: 20, step: 2, toolName: 'read_record' },
    ]
    const evaluation = evaluateGoldenCase(
        fixture,
        makeResult(fixture, { steps: 2, toolCalls: 2 }),
        repeatedEvents
    )

    assert.deepEqual(evaluation, { caseId: fixture.id, passed: true, findings: [] })
})

test('golden evaluation detects wrong run identity and invalid counters', () => {
    const fixture = makeCase()
    const evaluation = evaluateGoldenCase(
        fixture,
        makeResult(fixture, { runId: 'another-run-0001', steps: Number.NaN, toolCalls: -1 }),
        makeEvents()
    )

    assert.equal(evaluation.passed, false)
    assert.ok(evaluation.findings.includes('result run id did not match the fixture'))
    assert.ok(evaluation.findings.includes('result counters were invalid'))
})

test('golden evaluation reports missing tools, forbidden events, and order mismatches', () => {
    const fixture = makeCase({
        expectedTools: ['read_record', 'write_record'],
        expectedToolSequence: ['read_record', 'write_record'],
        forbiddenTools: ['read_record'],
        requiredEventTypes: ['approval_required'],
        forbiddenEventTypes: ['run_succeeded'],
    })
    const evaluation = evaluateGoldenCase(fixture, makeResult(fixture), makeEvents())

    assert.equal(evaluation.passed, false)
    assert.ok(evaluation.findings.some((finding) => finding.includes('write_record')))
    assert.ok(evaluation.findings.some((finding) => finding.includes('forbidden tool')))
    assert.ok(evaluation.findings.includes('tool call order did not match the expected sequence'))
    assert.ok(evaluation.findings.some((finding) => finding.includes('approval_required')))
    assert.ok(evaluation.findings.some((finding) => finding.includes('run_succeeded')))
})

test('golden evaluation enforces count bounds and expected approval state', () => {
    const fixture = makeCase({
        minSteps: 3,
        maxSteps: 3,
        minToolCalls: 2,
        maxToolCalls: 2,
        expectedPendingApprovalTool: 'write_record',
    })
    const belowBounds = evaluateGoldenCase(
        fixture,
        makeResult(fixture, { steps: 2, toolCalls: 1 }),
        makeEvents()
    )
    const aboveBounds = evaluateGoldenCase(
        fixture,
        makeResult(fixture, { steps: 4, toolCalls: 3 }),
        makeEvents()
    )

    assert.ok(belowBounds.findings.includes('minimum step count was not met'))
    assert.ok(belowBounds.findings.includes('minimum tool call count was not met'))
    assert.ok(belowBounds.findings.includes('pending approval tool did not match the expected value'))
    assert.ok(aboveBounds.findings.includes('maximum step count was exceeded'))
    assert.ok(aboveBounds.findings.includes('maximum tool call count was exceeded'))
})

test('golden evaluation fails closed on a raw sensitive field in an event', () => {
    const fixture = makeCase()
    const evaluation = evaluateGoldenCase(fixture, makeResult(fixture), [
        ...makeEvents(),
        { type: 'tool_call_succeeded', at: 20, detail: { accessToken: 'private-value' } },
    ])

    assert.equal(evaluation.passed, false)
    assert.ok(evaluation.findings.includes('event privacy check failed'))
    assert.equal(JSON.stringify(evaluation).includes('private-value'), false)
})

test('golden evaluation fails closed on cyclic event data without echoing content', () => {
    const fixture = makeCase()
    const detail: Record<string, unknown> = { password: 'secret-cycle-value' }
    detail.self = detail
    const evaluation = evaluateGoldenCase(fixture, makeResult(fixture), [
        ...makeEvents(),
        { type: 'tool_call_succeeded', at: 20, detail: detail as never },
    ])

    assert.equal(evaluation.passed, false)
    assert.ok(evaluation.findings.includes('event privacy check failed'))
    assert.equal(JSON.stringify(evaluation).includes('secret-cycle-value'), false)
})

test('golden evaluation accepts already-redacted sensitive details', () => {
    const fixture = makeCase()
    const evaluation = evaluateGoldenCase(fixture, makeResult(fixture), [
        ...makeEvents(),
        { type: 'tool_call_succeeded', at: 20, detail: { accessToken: '[REDACTED]' } },
    ])

    assert.equal(evaluation.passed, true)
})

test('suite runner executes each repetition and gates a stable case', async () => {
    const fixture = makeCase()
    const report = await runFixture(makeSuite(fixture, { repetitions: 3 }), async () => makeOutput(fixture))

    assert.equal(report.schemaVersion, 1)
    assert.equal(report.suiteId, 'agentic.safe-eval.v1')
    assert.equal(report.caseCount, 1)
    assert.equal(report.repetitionCount, 3)
    assert.equal(report.passedCases, 1)
    assert.equal(report.failedCases, 0)
    assert.equal(report.unstableCases, 0)
    assert.equal(report.score, 1)
    assert.equal(report.gate.passed, true)
    assert.equal(report.cases[0].repetitions.length, 3)
})

test('suite runner excludes event timestamps from deterministic comparisons', async () => {
    const fixture = makeCase()
    let at = 0
    const report = await runFixture(makeSuite(fixture, { repetitions: 4 }), async () => {
        at += 100
        return makeOutput(fixture, {}, makeEvents(at))
    })

    assert.equal(report.cases[0].stable, true)
    assert.equal(report.cases[0].passed, true)
    assert.equal(report.gate.passed, true)
})

test('determinism fingerprints ignore opaque approval IDs and expiry timestamps', async () => {
    const fixture = makeCase({
        expectedStatus: 'waiting_for_approval',
        expectedTools: [],
        expectedPendingApprovalTool: 'write_record',
        requiredEventTypes: ['approval_required'],
    })
    let invocation = 0
    const report = await runFixture(makeSuite(fixture, { repetitions: 2 }), async () => {
        invocation += 1
        return makeOutput(fixture, {
            status: 'waiting_for_approval',
            output: undefined,
            pendingApproval: {
                id: `opaque-approval-id-number-${invocation}`,
                toolName: 'write_record',
                inputDigest: 'a'.repeat(64),
                expiresAt: 10_000 + invocation,
            },
        }, [{
            type: 'approval_required',
            at: invocation,
            toolName: 'write_record',
            detail: { approvalId: `opaque-approval-id-number-${invocation}`, expiresAt: 10_000 + invocation },
        }])
    })

    assert.equal(report.cases[0].stable, true)
    assert.equal(report.cases[0].passed, true)
    assert.equal(report.gate.passed, true)
})

test('suite runner marks changed outputs unstable without exposing output content', async () => {
    const fixture = makeCase()
    let invocation = 0
    const report = await runFixture(makeSuite(fixture, { repetitions: 2 }), async () => {
        invocation += 1
        return makeOutput(fixture, { output: invocation === 1 ? 'expected output' : 'secret variation' })
    })
    const serialized = JSON.stringify(report)

    assert.equal(report.cases[0].stable, false)
    assert.equal(report.cases[0].passed, false)
    assert.ok(report.cases[0].findings.includes('repeated executions were not deterministic'))
    assert.equal(report.gate.passed, false)
    assert.equal(serialized.includes('secret variation'), false)
    assert.equal(serialized.includes('expected output'), false)
})

test('suite runner compares event order and action identity across repetitions', async () => {
    const fixture = makeCase()
    let invocation = 0
    const report = await runFixture(makeSuite(fixture, { repetitions: 2 }), async () => {
        invocation += 1
        const events = invocation === 1
            ? makeEvents()
            : [
                { type: 'tool_call_started' as const, at: 1, toolName: 'read_record' },
                { type: 'model_step_started' as const, at: 2, step: 1 },
                { type: 'run_succeeded' as const, at: 3, status: 'succeeded' as const },
            ]
        return makeOutput(fixture, {}, events)
    })

    assert.equal(report.cases[0].stable, false)
    assert.equal(report.unstableCases, 1)
    assert.ok(report.gate.failures.includes('maximum unstable-case threshold was exceeded'))
})

test('nondeterministic suites can tolerate unstable repetitions if case expectations pass', async () => {
    const fixture = makeCase()
    let invocation = 0
    const report = await runFixture(makeSuite(fixture, {
        repetitions: 2,
        deterministic: false,
        thresholds: { minimumScore: 1, maximumFailedCases: 0, maximumUnstableCases: 0 },
    }), async () => {
        invocation += 1
        return makeOutput(fixture, { output: `answer-${invocation}` })
    })

    assert.equal(report.cases[0].stable, false)
    assert.equal(report.cases[0].passed, true)
    assert.equal(report.unstableCases, 1)
    assert.equal(report.gate.passed, true)
})

test('suite runner converts execution exceptions to safe failures', async () => {
    const fixture = makeCase()
    const report = await runFixture(makeSuite(fixture), async () => {
        throw new Error('Bearer provider-secret-never-serialize')
    })
    const serialized = JSON.stringify(report)

    assert.equal(report.failedCases, 1)
    assert.equal(report.cases[0].repetitions[0].findings[0], 'evaluation execution failed')
    assert.equal(serialized.includes('provider-secret-never-serialize'), false)
})

test('suite runner rejects structurally invalid executor responses safely', async () => {
    const fixture = makeCase()
    const report = await runFixture(makeSuite(fixture), async () => null as never)

    assert.equal(report.failedCases, 1)
    assert.deepEqual(report.cases[0].findings, ['evaluation output was invalid'])
})

test('suite runner bounds event transcript size before fingerprinting', async () => {
    const fixture = makeCase()
    const events = Array.from({ length: 4_097 }, (_, index): RunEvent => ({
        type: 'model_step_started',
        at: index,
        step: index,
    }))
    const report = await runFixture(makeSuite(fixture), async () => makeOutput(fixture, {}, events))

    assert.equal(report.failedCases, 1)
    assert.deepEqual(report.cases[0].findings, ['event count exceeded the evaluation limit'])
})

test('suite runner creates a privacy-safe report without task or output text', async () => {
    const fixture = makeCase({
        input: { ...makeCase().input, task: 'private evaluation task text' },
        outputIncludes: undefined,
    })
    const report = await runFixture(makeSuite(fixture), async () =>
        makeOutput(fixture, { output: 'private model answer content' })
    )
    const artifact = JSON.stringify(report)

    assert.equal(artifact.includes('private evaluation task text'), false)
    assert.equal(artifact.includes('private model answer content'), false)
    assert.equal(artifact.includes(fixture.input.principal.id), false)
    assert.equal(artifact.includes(fixture.input.runId), false)
})

test('suite runner isolates fixture mutations between repetitions', async () => {
    const fixture = makeCase()
    const observed: string[] = []
    await runFixture(makeSuite(fixture, { repetitions: 2 }), async (copy) => {
        observed.push(copy.input.task)
        ;(copy.input.principal.permissions as string[]).push('mutated_permission')
        return makeOutput(fixture)
    })

    assert.deepEqual(observed, [fixture.input.task, fixture.input.task])
    assert.deepEqual(fixture.input.principal.permissions, ['records_read'])
})

test('suite validation rejects unsupported versions and malformed suite identifiers', () => {
    const badVersion = makeSuite(makeCase(), { schemaVersion: 2 as never })
    const badId = makeSuite(makeCase(), { suiteId: '../private' })
    assert.ok(validateEvaluationSuite(badVersion).some((issue) => issue.code === 'unsupported_version'))
    assert.ok(validateEvaluationSuite(badId).some((issue) => issue.code === 'invalid_identifier'))
})

test('suite validation rejects empty, excessive, and duplicate fixture identifiers', () => {
    assert.ok(validateEvaluationSuite(makeSuite(makeCase(), { cases: [] })).some(
        (issue) => issue.code === 'case_count_out_of_range'
    ))
    const first = makeCase()
    const duplicate = makeCase({ id: first.id, input: { ...first.input, runId: 'run-evaluation-0002' } })
    const repeatedRunId = makeCase({ id: 'second-case', input: first.input })
    assert.ok(validateEvaluationSuite(makeSuite(first, { cases: [first, duplicate] })).some(
        (issue) => issue.code === 'duplicate_case_id'
    ))
    assert.ok(validateEvaluationSuite(makeSuite(first, { cases: [first, repeatedRunId] })).some(
        (issue) => issue.code === 'duplicate_run_id'
    ))
    assert.ok(validateEvaluationSuite(makeSuite(first, {
        cases: Array.from({ length: 51 }, (_, index) => makeCase({
            id: `case-${index}`,
            input: { ...first.input, runId: `run-evaluation-${String(index).padStart(4, '0')}` },
        })),
    })).some((issue) => issue.code === 'case_count_out_of_range'))
})

test('suite validation caps repetitions and aggregate execution count', () => {
    const tooManyRepetitions = validateEvaluationSuite(makeSuite(makeCase(), { repetitions: 11 }))
    assert.ok(tooManyRepetitions.some((issue) => issue.code === 'repetition_count_out_of_range'))

    const fixtures = Array.from({ length: 50 }, (_, index) => makeCase({
        id: `case-${index}`,
        input: { ...makeCase().input, runId: `run-evaluation-${String(index).padStart(4, '0')}` },
    }))
    const tooManyRuns = validateEvaluationSuite(makeSuite(fixtures[0], {
        cases: fixtures,
        repetitions: 11,
    }))
    assert.ok(tooManyRuns.some((issue) => issue.code === 'repetition_count_out_of_range'))
})

test('suite validation rejects duplicate tool lists but permits repeated tool sequences', () => {
    const repeatedSequence = makeCase({ expectedToolSequence: ['read_record', 'read_record'] })
    assert.deepEqual(validateEvaluationSuite(makeSuite(repeatedSequence)), [])
    const duplicateSet = makeCase({ expectedTools: ['read_record', 'read_record'] })
    assert.ok(validateEvaluationSuite(makeSuite(duplicateSet)).some(
        (issue) => issue.code === 'duplicate_tool_name'
    ))
})

test('suite validation finds contradictory tool and event requirements', () => {
    const fixture = makeCase({
        expectedTools: ['read_record'],
        forbiddenTools: ['read_record'],
        requiredEventTypes: ['run_succeeded'],
        forbiddenEventTypes: ['run_succeeded'],
    })
    const issues = validateEvaluationSuite(makeSuite(fixture))

    assert.ok(issues.some((issue) => issue.code === 'conflicting_tool_expectations'))
    assert.ok(issues.some((issue) => issue.code === 'conflicting_event_expectations'))
})

test('suite validation rejects invalid budgets and inversions in evaluation bounds', () => {
    const fixture = makeCase({
        input: { ...makeCase().input, budget: { maxSteps: 100 } },
        minSteps: 8,
        maxSteps: 2,
        minToolCalls: -1,
    })
    const issues = validateEvaluationSuite(makeSuite(fixture))

    assert.ok(issues.some((issue) => issue.code === 'invalid_budget'))
    assert.ok(issues.some((issue) => issue.code === 'counter_bounds_inverted'))
    assert.ok(issues.some((issue) => issue.code === 'counter_out_of_range'))
})

test('suite validation rejects signal-bearing fixtures and unscoped approvals', () => {
    const input: AgentRunInput = {
        ...makeCase().input,
        signal: new AbortController().signal,
        approval: {
            id: 'approval-with-invalid-id',
            runId: 'run-other-0001',
            principalId: 'another-user',
            tenantId: 'another-tenant',
            toolName: 'publish_draft',
            inputDigest: 'invalid',
            expiresAt: 5,
        },
    }
    const issues = validateEvaluationSuite(makeSuite(makeCase({ input })))

    assert.ok(issues.some((issue) => issue.code === 'signals_not_allowed_in_fixtures'))
    assert.ok(issues.some((issue) => issue.code === 'approval_scope_mismatch'))
})

test('suite validation rejects invalid permissions, statuses, and event type values', () => {
    const fixture = makeCase({
        expectedStatus: 'imaginary' as never,
        requiredEventTypes: ['invented_event' as never],
        input: {
            ...makeCase().input,
            principal: { ...makeCase().input.principal, permissions: ['bad permission'] },
        },
    })
    const issues = validateEvaluationSuite(makeSuite(fixture))

    assert.ok(issues.some((issue) => issue.code === 'invalid_run_status'))
    assert.ok(issues.some((issue) => issue.code === 'invalid_event_type'))
    assert.ok(issues.some((issue) => issue.code === 'invalid_permissions'))
})

test('suite validation rejects threshold values outside their bounded ranges', () => {
    const issues = validateEvaluationSuite(makeSuite(makeCase(), {
        thresholds: {
            minimumScore: 1.1,
            maximumFailedCases: -1,
            maximumUnstableCases: 51,
        },
    }))

    assert.ok(issues.some((issue) => issue.code === 'score_threshold_out_of_range'))
    assert.equal(issues.filter((issue) => issue.code === 'count_threshold_out_of_range').length, 2)
})

test('invalid suites are rejected before the executor is called', async () => {
    let calls = 0
    const invalid = makeSuite(makeCase(), { suiteId: 'bad id' })

    await assert.rejects(
        runVersionedEvaluationSuite(invalid, async () => {
            calls += 1
            return makeOutput(makeCase())
        }),
        (error: unknown) => error instanceof EvaluationSuiteValidationError
    )
    assert.equal(calls, 0)
})

test('suite report duration is finite and clamps a backwards clock', async () => {
    const fixture = makeCase()
    const report = await runFixture(makeSuite(fixture), async () => makeOutput(fixture), [200, 100])

    assert.equal(report.startedAt, 200)
    assert.equal(report.durationMs, 0)
    assert.equal(Number.isFinite(report.durationMs), true)
})

test('quality gate respects configured failure allowance and score threshold', async () => {
    const fixture = makeCase({ expectedTools: ['missing_tool'] })
    const report = await runFixture(makeSuite(fixture, {
        thresholds: { minimumScore: 0, maximumFailedCases: 1, maximumUnstableCases: 0 },
    }), async () => makeOutput(fixture))

    assert.equal(report.failedCases, 1)
    assert.equal(report.gate.passed, true)
    assert.doesNotThrow(() => assertEvaluationGate(report))
})

test('quality gate throws only a safe aggregate error when thresholds fail', async () => {
    const fixture = makeCase({ input: { ...makeCase().input, task: 'secret task not for artifacts' } })
    const report = await runFixture(makeSuite(fixture), async () =>
        makeOutput(fixture, { output: 'secret output not for artifacts' }, [])
    )

    assert.equal(report.gate.passed, false)
    assert.throws(() => assertEvaluationGate(report), (error: unknown) => {
        assert.ok(error instanceof EvaluationGateError)
        assert.equal(JSON.stringify(error).includes('secret task'), false)
        assert.equal(JSON.stringify(error).includes('secret output'), false)
        assert.ok(error.failures.length > 0)
        return true
    })
})

test('suite runner can require a pending approval as an expected safe outcome', async () => {
    const fixture = makeCase({
        expectedStatus: 'waiting_for_approval',
        expectedTools: [],
        minToolCalls: 1,
        expectedPendingApprovalTool: 'write_record',
        requiredEventTypes: ['approval_required'],
    })
    const output = makeOutput(fixture, {
        status: 'waiting_for_approval',
        output: undefined,
        pendingApproval: {
            id: 'opaque-pending-approval-identifier',
            toolName: 'write_record',
            inputDigest: 'a'.repeat(64),
            expiresAt: 100_000,
        },
    }, [{ type: 'approval_required', at: 1, toolName: 'write_record' }])
    const report = await runFixture(makeSuite(fixture), async () => output)

    assert.equal(report.passedCases, 1)
    assert.equal(report.gate.passed, true)
})

test('legacy sequential suite runner remains fail-closed and does not serialize thrown errors', async () => {
    const first = makeCase({ id: 'legacy-a' })
    const second = makeCase({ id: 'legacy-b', input: { ...makeCase().input, runId: 'run-evaluation-0002' } })
    const { runEvaluationSuite } = await import('../src/agentic/evaluation')
    let calls = 0
    const summary = await runEvaluationSuite([first, second], async (fixture) => {
        calls += 1
        if (fixture.id === first.id) throw new Error('secret-token-value')
        return makeOutput(fixture)
    })

    assert.equal(calls, 2)
    assert.equal(summary.failed, 1)
    assert.equal(summary.passed, 1)
    assert.equal(JSON.stringify(summary).includes('secret-token-value'), false)
})
