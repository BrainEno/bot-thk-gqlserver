import { createHash } from 'crypto'
import { JsonValue } from './types'
import { isJsonValue } from './validation'

export class NonCanonicalValueError extends Error {
    constructor() {
        super('value is not safe canonical JSON')
        this.name = 'NonCanonicalValueError'
    }
}

export const canonicalJson = (value: unknown): string => {
    if (!isJsonValue(value)) throw new NonCanonicalValueError()
    return serialize(value)
}

export const digestJson = (value: JsonValue): string =>
    createHash('sha256').update(canonicalJson(value)).digest('hex')

const serialize = (value: JsonValue): string => {
    if (value === null || typeof value !== 'object') return JSON.stringify(value)
    if (Array.isArray(value)) return `[${value.map(serialize).join(',')}]`

    const object = value as Record<string, JsonValue>
    const properties = Object.keys(object)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${serialize(object[key])}`)
    return `{${properties.join(',')}}`
}
