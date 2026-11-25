import { AgentTool, ModelToolDescription } from './types'
import { JsonSchema } from './validation'

const NAME_PATTERN = /^[a-z][a-z0-9_]{1,63}$/
const MAX_TOOL_COUNT = 32

export class ToolRegistryError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'ToolRegistryError'
    }
}

export class ToolRegistry {
    private readonly tools = new Map<string, AgentTool>()
    private sealed = false

    register(tool: AgentTool): this {
        if (this.sealed) throw new ToolRegistryError('tool registry is sealed')
        if (!tool || typeof tool !== 'object') {
            throw new ToolRegistryError('tool definition must be an object')
        }
        if (typeof tool.name !== 'string' || !NAME_PATTERN.test(tool.name)) {
            throw new ToolRegistryError('tool name must be a lowercase identifier')
        }
        if (this.tools.has(tool.name)) {
            throw new ToolRegistryError('tool name is already registered')
        }
        if (this.tools.size >= MAX_TOOL_COUNT) {
            throw new ToolRegistryError('tool registry capacity exceeded')
        }
        if (
            typeof tool.description !== 'string' ||
            !tool.description.trim() ||
            tool.description.length > 500
        ) {
            throw new ToolRegistryError('tool description must contain 1 to 500 characters')
        }
        if (!Array.isArray(tool.requiredPermissions) ||
            tool.requiredPermissions.some(
                (permission) => typeof permission !== 'string' || !NAME_PATTERN.test(permission)
            )) {
            throw new ToolRegistryError('tool permission names must be lowercase identifiers')
        }
        if (tool.sideEffect !== 'read_only' && tool.sideEffect !== 'write') {
            throw new ToolRegistryError('tool side effect must be declared')
        }
        if (typeof tool.execute !== 'function') {
            throw new ToolRegistryError('tool executor must be a function')
        }
        validateSchemaDefinition(tool.inputSchema, 0, { visited: 0 })
        this.tools.set(tool.name, Object.freeze({
            ...tool,
            requiredPermissions: Object.freeze([...new Set(tool.requiredPermissions)]),
        }))
        return this
    }

    seal(): this {
        this.sealed = true
        return this
    }

    get(name: string): AgentTool | undefined {
        return this.tools.get(name)
    }

    descriptions(): readonly ModelToolDescription[] {
        return [...this.tools.values()].map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
        }))
    }

    names(): readonly string[] {
        return [...this.tools.keys()]
    }
}

const validateSchemaDefinition = (
    schema: JsonSchema,
    depth: number,
    budget: { visited: number }
): void => {
    budget.visited += 1
    if (budget.visited > 512) throw new ToolRegistryError('tool schema node budget exceeded')
    if (depth > 12) throw new ToolRegistryError('tool schema nesting exceeds limit')
    if (!schema || typeof schema !== 'object') {
        throw new ToolRegistryError('tool schema must be an object')
    }
    const validTypes = ['null', 'boolean', 'number', 'integer', 'string', 'array', 'object']
    if (!validTypes.includes(schema.type)) {
        throw new ToolRegistryError('tool schema has an unsupported type')
    }
    for (const [value, name] of [
        [schema.minLength, 'minLength'],
        [schema.maxLength, 'maxLength'],
        [schema.minItems, 'minItems'],
        [schema.maxItems, 'maxItems'],
    ] as const) {
        if (value !== undefined && (!Number.isInteger(value) || value < 0 || value > 100_000)) {
            throw new ToolRegistryError(`tool schema ${name} is invalid`)
        }
    }
    if (
        (schema.minimum !== undefined && !Number.isFinite(schema.minimum)) ||
        (schema.maximum !== undefined && !Number.isFinite(schema.maximum))
    ) {
        throw new ToolRegistryError('tool schema numeric bounds must be finite')
    }
    if (
        schema.minimum !== undefined &&
        schema.maximum !== undefined &&
        schema.minimum > schema.maximum
    ) {
        throw new ToolRegistryError('tool schema numeric range is inverted')
    }
    if (schema.minLength !== undefined && schema.maxLength !== undefined && schema.minLength > schema.maxLength) {
        throw new ToolRegistryError('tool schema string range is inverted')
    }
    if (schema.minItems !== undefined && schema.maxItems !== undefined && schema.minItems > schema.maxItems) {
        throw new ToolRegistryError('tool schema array range is inverted')
    }
    if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== 'boolean') {
        throw new ToolRegistryError('tool schema additionalProperties must be boolean')
    }
    if (schema.enum && (!Array.isArray(schema.enum) || schema.enum.length === 0 || schema.enum.length > 100)) {
        throw new ToolRegistryError('tool schema enum must contain 1 to 100 values')
    }
    if (schema.type === 'array' && !schema.items) {
        throw new ToolRegistryError('array tool schemas must define items')
    }
    const properties = schema.properties ?? {}
    if (typeof properties !== 'object' || properties === null || Array.isArray(properties)) {
        throw new ToolRegistryError('tool schema properties must be an object')
    }
    const propertyNames = Object.keys(properties)
    if (propertyNames.length > 64) {
        throw new ToolRegistryError('tool schema has too many properties')
    }
    if (propertyNames.some((key) => ['__proto__', 'prototype', 'constructor'].includes(key))) {
        throw new ToolRegistryError('tool schema contains a reserved property name')
    }
    for (const child of Object.values(properties)) {
        validateSchemaDefinition(child, depth + 1, budget)
    }
    if (schema.items) validateSchemaDefinition(schema.items, depth + 1, budget)
    if (!Array.isArray(schema.required ?? [])) {
        throw new ToolRegistryError('tool schema required must be an array')
    }
    if ((schema.required ?? []).some((key) => typeof key !== 'string' || !propertyNames.includes(key))) {
        throw new ToolRegistryError('required tool schema key is not declared')
    }
}
