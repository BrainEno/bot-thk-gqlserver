import { createCipheriv, createDecipheriv, randomBytes } from 'crypto'
import { canonicalJson, digestJson } from './canonicalJson'
import {
    AgentBudget,
    AgentMessage,
    AgentRunCheckpoint,
    CheckpointCipher,
    PendingToolAction,
    SealedRunCheckpoint,
} from './types'
import { isJsonValue } from './validation'

const KEY_BYTES = 32
const IV_BYTES = 12
const AUTH_TAG_BYTES = 16
const MAX_CHECKPOINT_BYTES = 1_000_000
const RUN_ID_PATTERN = /^[A-Za-z0-9_-]{8,96}$/
const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{1,63}$/

export class CheckpointCipherError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'CheckpointCipherError'
    }
}

/** AES-GCM envelope encryption for private continuation state persisted with a run. */
export class AesGcmCheckpointCipher implements CheckpointCipher {
    private readonly key: Buffer

    constructor(key: Uint8Array) {
        if (key.byteLength !== KEY_BYTES) {
            throw new CheckpointCipherError('checkpoint encryption key must be exactly 32 bytes')
        }
        this.key = Buffer.from(key)
    }

    seal(runId: string, checkpoint: AgentRunCheckpoint): SealedRunCheckpoint {
        assertRunId(runId)
        if (!isAgentRunCheckpoint(checkpoint)) {
            throw new CheckpointCipherError('checkpoint does not match the supported schema')
        }
        const plaintext = Buffer.from(canonicalJson(checkpoint), 'utf8')
        if (plaintext.byteLength > MAX_CHECKPOINT_BYTES) {
            throw new CheckpointCipherError('checkpoint exceeds the maximum encrypted payload size')
        }

        const iv = randomBytes(IV_BYTES)
        const cipher = createCipheriv('aes-256-gcm', this.key, iv)
        cipher.setAAD(aadFor(runId))
        const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
        return {
            version: 1,
            algorithm: 'aes-256-gcm',
            iv: iv.toString('base64url'),
            authTag: cipher.getAuthTag().toString('base64url'),
            ciphertext: ciphertext.toString('base64url'),
        }
    }

    open(runId: string, envelope: SealedRunCheckpoint): AgentRunCheckpoint {
        assertRunId(runId)
        const { iv, authTag, ciphertext } = validateEnvelope(envelope)
        try {
            const decipher = createDecipheriv('aes-256-gcm', this.key, iv)
            decipher.setAAD(aadFor(runId))
            decipher.setAuthTag(authTag)
            const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
            if (plaintext.byteLength > MAX_CHECKPOINT_BYTES) {
                throw new CheckpointCipherError('checkpoint exceeds the maximum encrypted payload size')
            }
            const parsed: unknown = JSON.parse(plaintext.toString('utf8'))
            if (!isAgentRunCheckpoint(parsed)) {
                throw new CheckpointCipherError('decrypted checkpoint does not match the supported schema')
            }
            return parsed
        } catch (error) {
            if (error instanceof CheckpointCipherError) throw error
            // Deliberately hide crypto/parser details: they can contain attacker-controlled bytes.
            throw new CheckpointCipherError('checkpoint authentication or decoding failed')
        }
    }
}

export const isAgentRunCheckpoint = (value: unknown): value is AgentRunCheckpoint => {
    if (!isPlainObject(value) || value.schemaVersion !== 1) return false
    if (
        typeof value.task !== 'string' ||
        value.task.trim().length === 0 ||
        value.task.length > 16_000 ||
        !Array.isArray(value.messages) ||
        value.messages.length < 1 ||
        value.messages.length > 128 ||
        !isBudget(value.budget) ||
        !isCounter(value.stepCount, 1, value.budget.maxSteps) ||
        !isCounter(value.toolCallCount, 1, value.budget.maxToolCalls) ||
        !isPendingAction(value.pendingAction) ||
        typeof value.createdAt !== 'number' ||
        !Number.isFinite(value.createdAt) ||
        typeof value.expiresAt !== 'number' ||
        !Number.isFinite(value.expiresAt) ||
        value.expiresAt <= value.createdAt ||
        !isCounter(value.remainingDurationMs, 1, value.budget.maxDurationMs)
    ) {
        return false
    }
    return value.messages.every(isAgentMessage) && value.toolCallCount <= value.stepCount
}

const isBudget = (value: unknown): value is AgentBudget => {
    if (!isPlainObject(value)) return false
    return (
        isCounter(value.maxSteps, 1, 20) &&
        isCounter(value.maxToolCalls, 1, 10) &&
        isCounter(value.maxDurationMs, 1, 120_000) &&
        isCounter(value.perOperationTimeoutMs, 1, 30_000) &&
        value.perOperationTimeoutMs <= value.maxDurationMs &&
        isCounter(value.maxOutputChars, 1, 32_000)
    )
}

const isPendingAction = (value: unknown): value is PendingToolAction => {
    if (!isPlainObject(value)) return false
    if (
        typeof value.callId !== 'string' ||
        value.callId.length < 1 ||
        value.callId.length > 128 ||
        typeof value.toolName !== 'string' ||
        !TOOL_NAME_PATTERN.test(value.toolName) ||
        typeof value.inputDigest !== 'string' ||
        !/^[a-f0-9]{64}$/.test(value.inputDigest) ||
        !isJsonValue(value.input)
    ) {
        return false
    }
    try {
        return digestJson(value.input) === value.inputDigest
    } catch {
        return false
    }
}

const isAgentMessage = (value: unknown): value is AgentMessage => {
    if (!isPlainObject(value)) return false
    if (
        (value.role !== 'user' && value.role !== 'assistant' && value.role !== 'tool') ||
        typeof value.content !== 'string' ||
        value.content.length > 32_768
    ) {
        return false
    }
    return value.toolCallId === undefined ||
        (typeof value.toolCallId === 'string' && value.toolCallId.length > 0 && value.toolCallId.length <= 128)
}

const validateEnvelope = (
    value: SealedRunCheckpoint
): { iv: Buffer; authTag: Buffer; ciphertext: Buffer } => {
    if (
        !isPlainObject(value) ||
        value.version !== 1 ||
        value.algorithm !== 'aes-256-gcm' ||
        typeof value.iv !== 'string' ||
        typeof value.authTag !== 'string' ||
        typeof value.ciphertext !== 'string'
    ) {
        throw new CheckpointCipherError('checkpoint envelope is invalid')
    }
    const iv = decodeBase64Url(value.iv, IV_BYTES)
    const authTag = decodeBase64Url(value.authTag, AUTH_TAG_BYTES)
    const ciphertext = decodeBase64Url(value.ciphertext)
    if (ciphertext.byteLength === 0 || ciphertext.byteLength > MAX_CHECKPOINT_BYTES) {
        throw new CheckpointCipherError('checkpoint envelope size is invalid')
    }
    return { iv, authTag, ciphertext }
}

const decodeBase64Url = (encoded: string, expectedLength?: number): Buffer => {
    const maxEncodedLength = Math.ceil(MAX_CHECKPOINT_BYTES * 4 / 3)
    if (
        encoded.length === 0 ||
        encoded.length > (expectedLength === undefined ? maxEncodedLength : Math.ceil(expectedLength * 4 / 3)) ||
        !/^[A-Za-z0-9_-]+$/.test(encoded)
    ) {
        throw new CheckpointCipherError('checkpoint envelope encoding is invalid')
    }
    const decoded = Buffer.from(encoded, 'base64url')
    if (decoded.toString('base64url') !== encoded || (expectedLength !== undefined && decoded.length !== expectedLength)) {
        throw new CheckpointCipherError('checkpoint envelope encoding is invalid')
    }
    return decoded
}

const aadFor = (runId: string): Buffer => Buffer.from(`agentic-run-checkpoint:v1:${runId}`, 'utf8')

const assertRunId = (runId: string): void => {
    if (typeof runId !== 'string' || !RUN_ID_PATTERN.test(runId)) {
        throw new CheckpointCipherError('run id is invalid for checkpoint encryption')
    }
}

const isCounter = (value: unknown, min: number, max: number): value is number =>
    typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype
