import assert from 'node:assert/strict'
import test from 'node:test'
import {
    canReceiveMessage,
    isConversationParticipant,
    isRecipient,
    isRemovedConversationParticipant,
} from '../src/services/subscriptionAccess'

test('notification delivery is bound to the authenticated recipient, not client-supplied IDs', () => {
    const alice = { user: { _id: 'alice-id' } }
    const bob = { user: { _id: 'bob-id' } }
    const unauthenticated = { user: null }

    assert.equal(isRecipient(['alice-id'], alice), true)
    assert.equal(isRecipient(['alice-id'], bob), false)
    assert.equal(isRecipient(['alice-id'], unauthenticated), false)
    assert.equal(isRecipient(['alice-id'], undefined), false)
})

test('message subscription requires both the requested conversation and stored membership', () => {
    const alice = { user: { _id: 'alice-id' } }

    assert.equal(
        canReceiveMessage('conversation-a', 'conversation-a', ['alice-id', 'bob-id'], alice),
        true
    )
    assert.equal(
        canReceiveMessage('conversation-a', 'conversation-b', ['alice-id', 'bob-id'], alice),
        false
    )
    assert.equal(
        canReceiveMessage('conversation-a', 'conversation-a', ['bob-id'], alice),
        false
    )
    assert.equal(
        canReceiveMessage('conversation-a', 'conversation-a', ['alice-id'], { user: null }),
        false
    )
})

test('removed members get only removal metadata and no longer receive conversation updates', () => {
    const alice = { user: { _id: 'alice-id' } }
    const activeMembers = ['bob-id', 'carol-id']
    const removedMembers = ['alice-id']

    assert.equal(isConversationParticipant(activeMembers, alice), false)
    assert.equal(isRemovedConversationParticipant(removedMembers, alice), true)
    assert.equal(isRemovedConversationParticipant(['bob-id'], alice), false)
})
