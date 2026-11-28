import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import test from 'node:test'
import { hashPassword, verifyPassword } from '../src/services/passwordService'

test('scrypt password hashes verify without storing plaintext', async () => {
    const password = 'correct horse battery staple'
    const encoded = await hashPassword(password)

    assert.match(encoded, /^scrypt\$/)
    assert.equal(encoded.includes(password), false)

    const record = {
        hashed_password: encoded,
        save: async () => undefined,
    }

    assert.equal(await verifyPassword(record, password), true)
    assert.equal(await verifyPassword(record, 'wrong password'), false)
})

test('legacy HMAC-SHA1 passwords upgrade on successful verification', async () => {
    const password = 'legacy password'
    const salt = 'legacy-salt'
    const record = {
        salt,
        hashed_password: createHmac('sha1', salt).update(password).digest('hex'),
        saves: 0,
        async save() {
            this.saves += 1
        },
    }

    assert.equal(await verifyPassword(record, password), true)
    assert.match(record.hashed_password, /^scrypt\$/)
    assert.equal(record.salt, '')
    assert.equal(record.saves, 1)
    assert.equal(await verifyPassword(record, 'wrong password'), false)
})
