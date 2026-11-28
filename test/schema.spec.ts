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

    const userType = schema.getType('User')
    assert.ok(userType && 'getFields' in userType)
    const internalUserFields = userType.getFields()
    assert.equal(internalUserFields.salt, undefined)
    assert.equal(internalUserFields.hashed_password, undefined)
    assert.equal(internalUserFields.resetPasswordLink, undefined)
})

test('conversation removal subscription is part of the additive GraphQL contract', () => {
    process.env.NODE_ENV = 'test'
    const schema = createSchema()
    const subscriptionFields = schema.getSubscriptionType()?.getFields()

    assert.ok(subscriptionFields)
    assert.equal(subscriptionFields.conversationRemoved.type.toString(), 'String!')
    assert.deepEqual(
        subscriptionFields.blogPublished.args.map((arg) => arg.name),
        ['followingIds']
    )
    assert.deepEqual(
        subscriptionFields.userFollowed.args.map((arg) => arg.name),
        ['name']
    )
})

test('password reset contract requires a token, not an account identifier', () => {
    process.env.NODE_ENV = 'test'
    const schema = createSchema()
    const resetArgs = schema
        .getMutationType()
        ?.getFields().resetPassword.args.map((arg) => arg.name)

    assert.deepEqual(resetArgs?.sort(), ['password', 'token'])
})
