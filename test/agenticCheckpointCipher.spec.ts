import assert from 'node:assert/strict'
import test from 'node:test'
import {
    AesGcmCheckpointCipher,
    AgentRunCheckpoint,
    CheckpointCipherError,
    digestJson,
} from '../src/agentic'

const secretKey = Buffer.alloc(32, 91)
const runId = 'checkpoint-run-0001'

const checkpoint = (overrides: Partial<AgentRunCheckpoint> = {}): AgentRunCheckpoint => {
    const input = { draft: 'confidential draft content', destination: 'internal-only' }
    return {
        schemaVersion: 1,
        task: 'Create a confidential draft and wait for review.',
        messages: [
            { role: 'user', content: 'Create a confidential draft and wait for review.' },
            { role: 'assistant', content: 'Preparing the draft now.' },
        ],
        budget: {
            maxSteps: 6,
            maxToolCalls: 4,
            maxDurationMs: 30_000,
            perOperationTimeoutMs: 8_000,
            maxOutputChars: 8_000,
        },
        stepCount: 1,
        toolCallCount: 1,
        pendingAction: {
            callId: 'call-private-draft',
            toolName: 'write_draft',
            input,
            inputDigest: digestJson(input),
        },
        createdAt: 1_000,
        expiresAt: 91_000,
        remainingDurationMs: 20_000,
        ...overrides,
    }
}

test('checkpoint cipher round-trips a bounded continuation payload', () => {
    const cipher = new AesGcmCheckpointCipher(secretKey)
    const value = checkpoint()
    const envelope = cipher.seal(runId, value)

    assert.deepEqual(cipher.open(runId, envelope), value)
    assert.equal(envelope.version, 1)
    assert.equal(envelope.algorithm, 'aes-256-gcm')
    assert.equal(Buffer.from(envelope.iv, 'base64url').length, 12)
    assert.equal(Buffer.from(envelope.authTag, 'base64url').length, 16)
})

test('checkpoint ciphertext does not disclose task, message, input, or call id', () => {
    const value = checkpoint()
    const envelope = new AesGcmCheckpointCipher(secretKey).seal(runId, value)
    const serialized = JSON.stringify(envelope)

    for (const privateValue of [
        value.task,
        value.messages[0].content,
        'confidential draft content',
        'internal-only',
        'call-private-draft',
    ]) {
        assert.equal(serialized.includes(privateValue), false)
    }
})

test('checkpoint cipher uses fresh IVs even for identical payloads', () => {
    const cipher = new AesGcmCheckpointCipher(secretKey)
    const value = checkpoint()
    const first = cipher.seal(runId, value)
    const second = cipher.seal(runId, value)

    assert.notEqual(first.iv, second.iv)
    assert.notEqual(first.ciphertext, second.ciphertext)
    assert.deepEqual(cipher.open(runId, first), cipher.open(runId, second))
})

test('checkpoint authentication binds the envelope to its run id', () => {
    const cipher = new AesGcmCheckpointCipher(secretKey)
    const envelope = cipher.seal(runId, checkpoint())

    assert.throws(() => cipher.open('checkpoint-run-0002', envelope), CheckpointCipherError)
})

test('checkpoint authentication rejects modified ciphertext bytes', () => {
    const cipher = new AesGcmCheckpointCipher(secretKey)
    const envelope = cipher.seal(runId, checkpoint())
    const ciphertext = Buffer.from(envelope.ciphertext, 'base64url')
    ciphertext[0] ^= 0x80

    assert.throws(
        () => cipher.open(runId, { ...envelope, ciphertext: ciphertext.toString('base64url') }),
        /authentication or decoding failed/
    )
})

test('checkpoint authentication rejects modified authentication tags', () => {
    const cipher = new AesGcmCheckpointCipher(secretKey)
    const envelope = cipher.seal(runId, checkpoint())
    const tag = Buffer.from(envelope.authTag, 'base64url')
    tag[0] ^= 0x01

    assert.throws(
        () => cipher.open(runId, { ...envelope, authTag: tag.toString('base64url') }),
        CheckpointCipherError
    )
})

test('checkpoint encryption keys must contain exactly 256 bits', () => {
    for (const key of [Buffer.alloc(0), Buffer.alloc(16), Buffer.alloc(31), Buffer.alloc(33)]) {
        assert.throws(() => new AesGcmCheckpointCipher(key), CheckpointCipherError)
    }
    assert.doesNotThrow(() => new AesGcmCheckpointCipher(Buffer.alloc(32)))
})

test('checkpoint envelope rejects unsupported algorithm and version', () => {
    const cipher = new AesGcmCheckpointCipher(secretKey)
    const envelope = cipher.seal(runId, checkpoint())

    assert.throws(() => cipher.open(runId, { ...envelope, algorithm: 'aes-128-gcm' } as never), CheckpointCipherError)
    assert.throws(() => cipher.open(runId, { ...envelope, version: 2 } as never), CheckpointCipherError)
})

test('checkpoint envelope rejects non-canonical base64url encodings', () => {
    const cipher = new AesGcmCheckpointCipher(secretKey)
    const envelope = cipher.seal(runId, checkpoint())

    assert.throws(() => cipher.open(runId, { ...envelope, iv: `${envelope.iv}=` }), CheckpointCipherError)
    assert.throws(() => cipher.open(runId, { ...envelope, authTag: '***' }), CheckpointCipherError)
    assert.throws(() => cipher.open(runId, { ...envelope, ciphertext: '' }), CheckpointCipherError)
    assert.throws(
        () => cipher.open(runId, { ...envelope, ciphertext: 'A'.repeat(1_400_000) }),
        CheckpointCipherError
    )
})

test('checkpoint seal rejects a digest that does not bind the pending input', () => {
    const cipher = new AesGcmCheckpointCipher(secretKey)
    const value = checkpoint({
        pendingAction: {
            ...checkpoint().pendingAction,
            input: { draft: 'changed after approval' },
        },
    })

    assert.throws(() => cipher.seal(runId, value), CheckpointCipherError)
})

test('checkpoint seal rejects malformed budgets and inconsistent counters', () => {
    const cipher = new AesGcmCheckpointCipher(secretKey)
    const valid = checkpoint()

    assert.throws(() => cipher.seal(runId, checkpoint({
        budget: { ...valid.budget, maxSteps: 21 },
    })), CheckpointCipherError)
    assert.throws(() => cipher.seal(runId, checkpoint({ stepCount: 0 })), CheckpointCipherError)
    assert.throws(() => cipher.seal(runId, checkpoint({ stepCount: 0, toolCallCount: 0 })), CheckpointCipherError)
    assert.throws(() => cipher.seal(runId, checkpoint({ toolCallCount: 5 })), CheckpointCipherError)
})

test('checkpoint seal rejects malformed run ids and tool identifiers', () => {
    const cipher = new AesGcmCheckpointCipher(secretKey)

    assert.throws(() => cipher.seal('short', checkpoint()), CheckpointCipherError)
    assert.throws(() => cipher.open('bad/run/id', cipher.seal(runId, checkpoint())), CheckpointCipherError)
    assert.throws(() => cipher.seal(runId, checkpoint({
        pendingAction: { ...checkpoint().pendingAction, toolName: 'Write-Draft' },
    })), CheckpointCipherError)
})

test('checkpoint seal rejects malformed time windows and oversized message content', () => {
    const cipher = new AesGcmCheckpointCipher(secretKey)
    const valid = checkpoint()

    assert.throws(() => cipher.seal(runId, checkpoint({ expiresAt: valid.createdAt })), CheckpointCipherError)
    assert.throws(() => cipher.seal(runId, checkpoint({ remainingDurationMs: 0 })), CheckpointCipherError)
    assert.throws(() => cipher.seal(runId, checkpoint({
        messages: [{ role: 'assistant', content: 'x'.repeat(32_769) }],
    })), CheckpointCipherError)
})

test('checkpoint open rejects malformed envelope types before decryption', () => {
    const cipher = new AesGcmCheckpointCipher(secretKey)

    for (const malformed of [null, {}, 'bad', { version: 1 }, { ...cipher.seal(runId, checkpoint()), iv: 4 }]) {
        assert.throws(() => cipher.open(runId, malformed as never), CheckpointCipherError)
    }
})

test('checkpoint ciphertext cannot be opened using another valid key', () => {
    const writer = new AesGcmCheckpointCipher(secretKey)
    const reader = new AesGcmCheckpointCipher(Buffer.alloc(32, 92))
    const envelope = writer.seal(runId, checkpoint())

    assert.throws(() => reader.open(runId, envelope), CheckpointCipherError)
})
