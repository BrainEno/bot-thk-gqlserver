import assert from 'node:assert/strict'
import test from 'node:test'
import { createSchema } from '../src/utils/createSchema'

test('public profile schema omits private email and relationship fields', () => {
    process.env.NODE_ENV = 'test'
    const schema = createSchema()
    const publicUserFields = schema.getType('UserInfoResponse')

    assert.ok(publicUserFields && 'getFields' in publicUserFields)
    const fields = publicUserFields.getFields()
    assert.deepEqual(Object.keys(fields).sort(), [
        '_id',
        'about',
        'createdAt',
        'name',
        'photo',
        'username',
    ])
})

test('password reset contract requires a token, not an account identifier', () => {
    process.env.NODE_ENV = 'test'
    const schema = createSchema()
    const resetArgs = schema
        .getMutationType()
        ?.getFields().resetPassword.args.map((arg) => arg.name)

    assert.deepEqual(resetArgs?.sort(), ['password', 'token'])
})
