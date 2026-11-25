import assert from 'node:assert/strict'
import test from 'node:test'
import {
    MemoryTraceWriter,
    RedactingTraceSink,
    evaluateGoldenCase,
    redactValue,
    summarizeEvaluation,
} from '../src/agentic'

test('redaction masks secrets recursively and bounds unsafe structures', () => {
    const circular: Record<string, unknown> = { password: 'secret', count: 2 }
    circular.self = circular
    const cleaned = redactValue({
        authorization: 'Bearer token',
        nested: circular,
        list: ['safe', { apiKey: 'private' }],
        value: 'x'.repeat(3000),
    }) as Record<string, any>

    assert.equal(cleaned.authorization, '[REDACTED]')
    assert.equal(cleaned.nested.password, '[REDACTED]')
    assert.equal(cleaned.nested.self, '[CIRCULAR]')
    assert.equal(cleaned.list[1].apiKey, '[REDACTED]')
    assert.match(cleaned.value, /TRUNCATED/)
})

test('redaction preserves hostile-looking keys as data without changing prototypes', () => {
    const input = JSON.parse('{"__proto__":{"polluted":true},"constructor":"data"}')
    const cleaned = redactValue(input) as Record<string, unknown>
    assert.equal(Object.prototype.hasOwnProperty.call(cleaned, '__proto__'), true)
    assert.deepEqual(cleaned.__proto__, { polluted: true })
    assert.equal(cleaned.constructor, 'data')
    assert.equal(({} as { polluted?: boolean }).polluted, undefined)
})

test('trace sink redacts details before writing to the target adapter', async () => {
    const writer = new MemoryTraceWriter()
    const sink = new RedactingTraceSink(writer)
    await sink.emit(
        {
            type: 'tool_call_started',
            at: 1,
            toolName: 'safe_lookup',
            detail: { password: 'secret', count: 1 },
        },
        { runId: 'run-12345678', tenantId: 'tenant-a' }
    )
    const records = writer.readAll()
    assert.equal(records.length, 1)
    assert.equal(records[0].event.detail?.password, '[REDACTED]')
    assert.equal(records[0].event.detail?.count, 1)
})

test('golden evaluation checks final status, required tools, and forbidden tools', () => {
    const fixture = {
        id: 'case-1',
        input: {
            runId: 'run-12345678',
            task: 'look up public info',
            principal: { id: 'u-1', tenantId: 't-1', permissions: [] },
        },
        expectedStatus: 'succeeded' as const,
        outputIncludes: 'answer',
        expectedTools: ['safe_lookup'],
        forbiddenTools: ['publish_draft'],
    }
    const passing = evaluateGoldenCase(
        fixture,
        { runId: fixture.input.runId, status: 'succeeded', output: 'the answer', steps: 2, toolCalls: 1 },
        [{ type: 'tool_call_started', at: 1, toolName: 'safe_lookup' }]
    )
    assert.equal(passing.passed, true)

    const failing = evaluateGoldenCase(
        fixture,
        { runId: fixture.input.runId, status: 'failed', output: 'no result', steps: 1, toolCalls: 1 },
        [{ type: 'tool_call_started', at: 1, toolName: 'publish_draft' }]
    )
    assert.equal(failing.passed, false)
    assert.ok(failing.findings.length >= 3)
})

test('evaluation summary provides deterministic score and supports empty suites', () => {
    assert.deepEqual(summarizeEvaluation([]), {
        total: 0,
        passed: 0,
        failed: 0,
        score: 1,
        cases: [],
    })
    const summary = summarizeEvaluation([
        { caseId: 'a', passed: true, findings: [] },
        { caseId: 'b', passed: false, findings: ['miss'] },
    ])
    assert.equal(summary.score, 0.5)
    assert.equal(summary.failed, 1)
})
