import { AgentRunResult, GoldenCase, RunEvent } from './types'

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

export const evaluateGoldenCase = (
    fixture: GoldenCase,
    result: AgentRunResult,
    events: readonly RunEvent[]
): CaseEvaluation => {
    const findings: string[] = []
    if (result.status !== fixture.expectedStatus) {
        findings.push(`expected status ${fixture.expectedStatus}, got ${result.status}`)
    }
    if (fixture.outputIncludes && !result.output?.includes(fixture.outputIncludes)) {
        findings.push('expected output fragment was not present')
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
        const { result, events } = await execute(fixture)
        evaluations.push(evaluateGoldenCase(fixture, result, events))
    }
    return summarizeEvaluation(evaluations)
}
