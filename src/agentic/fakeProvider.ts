import { ModelDecision, ModelProvider, ModelRequest } from './types'

export class ScriptedFakeProvider implements ModelProvider {
    private cursor = 0
    private readonly observed: Array<{ runId: string; messageCount: number; toolNames: readonly string[] }> = []

    constructor(private readonly script: readonly ModelDecision[]) {}

    async nextAction(request: ModelRequest): Promise<ModelDecision> {
        if (request.signal.aborted) throw new Error('fake provider request aborted')
        this.observed.push({
            runId: request.runId,
            messageCount: request.messages.length,
            toolNames: request.tools.map((tool) => tool.name),
        })
        const decision = this.script[this.cursor]
        this.cursor += 1
        if (!decision) throw new Error('fake provider script exhausted')
        return cloneDecision(decision)
    }

    calls(): number {
        return this.cursor
    }

    observations(): readonly {
        runId: string
        messageCount: number
        toolNames: readonly string[]
    }[] {
        return this.observed.map((record) => ({
            ...record,
            toolNames: [...record.toolNames],
        }))
    }
}

const cloneDecision = (decision: ModelDecision): ModelDecision =>
    decision.kind === 'final'
        ? { kind: 'final', output: decision.output }
        : {
              kind: 'tool_call',
              callId: decision.callId,
              name: decision.name,
              input: cloneJson(decision.input),
          }

const cloneJson = (value: unknown): unknown => {
    if (value === null || typeof value !== 'object') return value
    if (Array.isArray(value)) return value.map(cloneJson)
    const copy: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        copy[key] = cloneJson(child)
    }
    return copy
}
