import assert from 'node:assert/strict'
import test from 'node:test'
import { Types } from 'mongoose'
import { toObjectId } from '../src/utils/toObjectId'

test('normalizes raw, string, and populated ObjectId references', () => {
    const id = new Types.ObjectId()

    assert.equal(toObjectId(id), id)
    assert.equal(toObjectId(id.toHexString()).toHexString(), id.toHexString())
    assert.equal(toObjectId({ _id: id }).toHexString(), id.toHexString())
})

test('rejects values that cannot be used as Mongo ObjectId references', () => {
    assert.throws(() => toObjectId('not-an-object-id'))
    assert.throws(() => toObjectId(null), /Expected a MongoDB ObjectId/)
})
