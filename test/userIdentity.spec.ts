import assert from 'node:assert/strict'
import test from 'node:test'
import { Types } from 'mongoose'
import { areUserIdsEqual, normalizeUserId } from '../src/services/userIdentity'

test('user ID comparisons normalize strings and Mongo ObjectIds', () => {
    const id = new Types.ObjectId()

    assert.equal(normalizeUserId(id), id.toString())
    assert.equal(areUserIdsEqual(id, id.toString()), true)
    assert.equal(areUserIdsEqual(id.toString(), new Types.ObjectId().toString()), false)
    assert.equal(areUserIdsEqual(null, id), false)
    assert.equal(areUserIdsEqual('', ''), false)
})
