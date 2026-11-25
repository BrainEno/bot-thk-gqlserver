import { JsonValue, RunEvent } from './types'

const SECRET_KEY = /(authorization|cookie|password|passwd|secret|token|api[_-]?key|credential|email|prompt|system[_-]?message)/i
const REDACTED = '[REDACTED]'
const MAX_DEPTH = 10
const MAX_ITEMS = 100
const MAX_STRING_LENGTH = 2048

export const redactValue = (value: unknown): JsonValue => {
    const seen = new Set<object>()
    let nodes = 0

    const visit = (current: unknown, key: string, depth: number): JsonValue => {
        nodes += 1
        if (SECRET_KEY.test(key)) return REDACTED
        if (depth > MAX_DEPTH || nodes > MAX_ITEMS) return '[TRUNCATED]'
        if (current === null || typeof current === 'boolean') return current
        if (typeof current === 'number') {
            return Number.isFinite(current) ? current : '[NON_FINITE]'
        }
        if (typeof current === 'string') {
            return current.length > MAX_STRING_LENGTH
                ? `${current.slice(0, MAX_STRING_LENGTH)}…[TRUNCATED]`
                : current
        }
        if (typeof current !== 'object') return `[${typeof current}]`
        if (seen.has(current)) return '[CIRCULAR]'

        seen.add(current)
        let result: JsonValue
        if (Array.isArray(current)) {
            result = current.slice(0, MAX_ITEMS).map((item) => visit(item, '', depth + 1))
            if (current.length > MAX_ITEMS) result.push('[TRUNCATED]')
        } else if (Object.getPrototypeOf(current) === Object.prototype) {
            const output: Record<string, JsonValue> = {}
            const entries = Object.entries(current as Record<string, unknown>)
            for (const [childKey, childValue] of entries.slice(0, MAX_ITEMS)) {
                Object.defineProperty(output, childKey, {
                    value: visit(childValue, childKey, depth + 1),
                    enumerable: true,
                    configurable: true,
                    writable: true,
                })
            }
            if (entries.length > MAX_ITEMS) output.__truncated = true
            result = output
        } else {
            result = '[NON_PLAIN_OBJECT]'
        }
        seen.delete(current)
        return result
    }

    return visit(value, '', 0)
}

export const redactEvent = (event: RunEvent): RunEvent => {
    const detail = event.detail
        ? (redactValue(event.detail) as Readonly<Record<string, JsonValue>>)
        : undefined
    return { ...event, detail }
}
