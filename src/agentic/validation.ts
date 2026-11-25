import { JsonValue } from './types'

export type JsonSchemaType =
    | 'null'
    | 'boolean'
    | 'number'
    | 'integer'
    | 'string'
    | 'array'
    | 'object'

export interface JsonSchema {
    readonly type: JsonSchemaType
    readonly description?: string
    readonly enum?: readonly JsonValue[]
    readonly minimum?: number
    readonly maximum?: number
    readonly minLength?: number
    readonly maxLength?: number
    readonly minItems?: number
    readonly maxItems?: number
    readonly items?: JsonSchema
    readonly properties?: Readonly<Record<string, JsonSchema>>
    readonly required?: readonly string[]
    readonly additionalProperties?: boolean
}

export interface ValidationIssue {
    readonly path: string
    readonly message: string
}

const DEFAULT_MAX_DEPTH = 16
const DEFAULT_MAX_NODES = 2048
const DEFAULT_MAX_STRING_LENGTH = 32_768

export const isJsonValue = (
    value: unknown,
    depth = 0,
    seen = new Set<object>()
): value is JsonValue => {
    if (depth > DEFAULT_MAX_DEPTH) return false
    if (
        value === null ||
        typeof value === 'string' ||
        typeof value === 'boolean'
    ) {
        return typeof value !== 'string' || value.length <= DEFAULT_MAX_STRING_LENGTH
    }
    if (typeof value === 'number') return Number.isFinite(value)
    if (typeof value !== 'object') return false

    if (seen.has(value)) return false
    seen.add(value)
    const valid = Array.isArray(value)
        ? value.every((item) => isJsonValue(item, depth + 1, seen))
        : Object.getPrototypeOf(value) === Object.prototype &&
          Object.values(value as Record<string, unknown>).every((item) =>
              isJsonValue(item, depth + 1, seen)
          )
    seen.delete(value)
    return valid
}

export const validateJsonSchema = (
    value: unknown,
    schema: JsonSchema,
    limits: { maxDepth?: number; maxNodes?: number } = {}
): ValidationIssue[] => {
    const maxDepth = limits.maxDepth ?? DEFAULT_MAX_DEPTH
    const maxNodes = limits.maxNodes ?? DEFAULT_MAX_NODES
    const issues: ValidationIssue[] = []
    let visited = 0

    const visit = (current: unknown, rule: JsonSchema, path: string, depth: number) => {
        visited += 1
        if (visited > maxNodes) {
            issues.push({ path, message: 'input exceeds the validation node budget' })
            return
        }
        if (depth > maxDepth) {
            issues.push({ path, message: 'input exceeds the maximum nesting depth' })
            return
        }

        if (!matchesType(current, rule.type)) {
            issues.push({ path, message: `expected ${rule.type}` })
            return
        }
        if (rule.enum && !rule.enum.some((candidate) => deepEqual(candidate, current))) {
            issues.push({ path, message: 'value is not in the allowed set' })
            return
        }

        if (typeof current === 'string') {
            if (current.length > DEFAULT_MAX_STRING_LENGTH) {
                issues.push({ path, message: 'string exceeds maximum length' })
            }
            if (rule.minLength !== undefined && current.length < rule.minLength) {
                issues.push({ path, message: `minimum length is ${rule.minLength}` })
            }
            if (rule.maxLength !== undefined && current.length > rule.maxLength) {
                issues.push({ path, message: `maximum length is ${rule.maxLength}` })
            }
            return
        }

        if (typeof current === 'number') {
            if (rule.minimum !== undefined && current < rule.minimum) {
                issues.push({ path, message: `minimum value is ${rule.minimum}` })
            }
            if (rule.maximum !== undefined && current > rule.maximum) {
                issues.push({ path, message: `maximum value is ${rule.maximum}` })
            }
            return
        }

        if (Array.isArray(current)) {
            if (rule.minItems !== undefined && current.length < rule.minItems) {
                issues.push({ path, message: `minimum item count is ${rule.minItems}` })
            }
            if (rule.maxItems !== undefined && current.length > rule.maxItems) {
                issues.push({ path, message: `maximum item count is ${rule.maxItems}` })
            }
            if (rule.items) {
                current.forEach((item, index) =>
                    visit(item, rule.items!, `${path}[${index}]`, depth + 1)
                )
            }
            return
        }

        if (isPlainObject(current)) {
            const properties = rule.properties ?? {}
            const required = rule.required ?? []

            for (const key of required) {
                if (!Object.prototype.hasOwnProperty.call(current, key)) {
                    issues.push({ path: `${path}.${key}`, message: 'required property is missing' })
                }
            }
            for (const key of Object.keys(current)) {
                const childSchema = Object.prototype.hasOwnProperty.call(properties, key)
                    ? properties[key]
                    : undefined
                if (!childSchema) {
                    if (rule.additionalProperties !== true) {
                        issues.push({ path: `${path}.${key}`, message: 'additional property is not allowed' })
                    }
                    continue
                }
                visit(current[key], childSchema, `${path}.${key}`, depth + 1)
            }
        }
    }

    if (!isJsonValue(value, 0)) {
        return [{ path: '$', message: 'input must be finite, plain JSON data' }]
    }
    visit(value, schema, '$', 0)
    return issues
}

const matchesType = (value: unknown, type: JsonSchemaType): boolean => {
    switch (type) {
        case 'null':
            return value === null
        case 'boolean':
            return typeof value === 'boolean'
        case 'number':
            return typeof value === 'number' && Number.isFinite(value)
        case 'integer':
            return typeof value === 'number' && Number.isInteger(value)
        case 'string':
            return typeof value === 'string'
        case 'array':
            return Array.isArray(value)
        case 'object':
            return isPlainObject(value)
    }
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype

const deepEqual = (left: unknown, right: unknown): boolean => {
    if (Object.is(left, right)) return true
    if (Array.isArray(left) && Array.isArray(right)) {
        return left.length === right.length && left.every((v, i) => deepEqual(v, right[i]))
    }
    if (isPlainObject(left) && isPlainObject(right)) {
        const leftKeys = Object.keys(left).sort()
        const rightKeys = Object.keys(right).sort()
        return (
            leftKeys.length === rightKeys.length &&
            leftKeys.every((key, index) => key === rightKeys[index] && deepEqual(left[key], right[key]))
        )
    }
    return false
}
