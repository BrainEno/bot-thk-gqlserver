import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import test from 'node:test'

const secretValues = [
    'password-secret',
    'token-secret',
    'authorization-secret',
    'header-secret',
    'cookie-secret',
]

test('production JSON logger redacts credentials and cookies', () => {
    const script = `const { logger, requestContext } = require('./src/services/LogService')
    requestContext.run({ requestId: 'request-id-test' }, () => logger.info({
        event: 'logger.redaction.test',
        password: '${secretValues[0]}',
        token: '${secretValues[1]}',
        authorization: '${secretValues[2]}',
        req: { headers: { authorization: '${secretValues[3]}', cookie: '${secretValues[4]}' } },
    }))`
    const output = execFileSync(
        process.execPath,
        ['-r', 'ts-node/register', '-e', script],
        {
            cwd: process.cwd(),
            env: { ...process.env, NODE_ENV: 'production', LOG_LEVEL: 'info' },
            encoding: 'utf8',
        }
    )
    const record = JSON.parse(output) as Record<string, unknown>

    assert.ok(secretValues.every((secret) => !output.includes(secret)))
    assert.equal(record.password, '[REDACTED]')
    assert.equal(record.token, '[REDACTED]')
    assert.equal(record.authorization, '[REDACTED]')
    assert.equal(record.requestId, 'request-id-test')
    assert.deepEqual(record.req, {
        headers: { authorization: '[REDACTED]', cookie: '[REDACTED]' },
    })
})
