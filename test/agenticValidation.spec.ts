import assert from 'node:assert/strict'
import test from 'node:test'
import { canonicalJson, digestJson, isJsonValue, validateJsonSchema } from '../src/agentic'
import { JsonSchema } from '../src/agentic/validation'

const schema: JsonSchema = {
    type: 'object',
    required: ['query'],
    properties: {
        query: { type: 'string', minLength: 1, maxLength: 80 },
        limit: { type: 'integer', minimum: 1, maximum: 10 },
        tags: { type: 'array', items: { type: 'string', maxLength: 16 }, maxItems: 5 },
    },
}

test('JSON schema validation accepts valid bounded input', () => {
    assert.deepEqual(
        validateJsonSchema({ query: 'weather', limit: 3, tags: ['local'] }, schema),
        []
    )
})

test('JSON schema validation rejects missing, excessive, and unknown fields', () => {
    const issues = validateJsonSchema(
        { query: '', limit: 11, extra: 'not allowed' },
        schema
    )
    assert.ok(issues.some((issue) => issue.path === '$.query' && issue.message.includes('minimum length')))
    assert.ok(issues.some((issue) => issue.path === '$.limit'))
    assert.ok(issues.some((issue) => issue.path === '$.extra'))
})

test('JSON validation fails closed on non-finite and non-plain values', () => {
    assert.equal(isJsonValue(Number.NaN), false)
    assert.equal(isJsonValue(new Date()), false)
    assert.equal(isJsonValue(() => undefined), false)
    assert.equal(validateJsonSchema(Number.NaN, { type: 'number' }).length, 1)
})

test('JSON validation detects cycles and respects nesting/node budgets', () => {
    const cyclic: { self?: unknown } = {}
    cyclic.self = cyclic
    assert.equal(isJsonValue(cyclic), false)
    assert.ok(validateJsonSchema({ query: 'ok' }, schema, { maxNodes: 1 }).length > 0)
    const deepSchema: JsonSchema = {
        type: 'object',
        properties: {
            a: {
                type: 'object',
                properties: {
                    b: {
                        type: 'object',
                        properties: { c: { type: 'string' } },
                    },
                },
            },
        },
    }
    assert.ok(
        validateJsonSchema({ a: { b: { c: 'deep' } } }, deepSchema, { maxDepth: 1 }).length > 0
    )
})

test('schema validation treats prototype-named keys as ordinary additional data', () => {
    const value = JSON.parse('{"constructor":"unexpected","__proto__":{"polluted":true}}')
    const issues = validateJsonSchema(value, { type: 'object', properties: {} })
    assert.equal(issues.length, 2)
    assert.equal(({} as { polluted?: boolean }).polluted, undefined)
})

test('canonical JSON sorts keys so approval digests are stable', () => {
    const left = { z: 1, nested: { b: true, a: 'x' } }
    const right = { nested: { a: 'x', b: true }, z: 1 }
    assert.equal(canonicalJson(left), canonicalJson(right))
    assert.equal(digestJson(left), digestJson(right))
    assert.notEqual(digestJson(left), digestJson({ ...right, z: 2 }))
})
