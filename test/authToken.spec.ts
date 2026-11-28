import assert from 'node:assert/strict'
import test from 'node:test'
import { extractBearerToken } from '../src/utils/authToken'

test('extracts only a well-formed Bearer token', () => {
    assert.equal(extractBearerToken('Bearer abc.def_123-~'), 'abc.def_123-~')
    assert.equal(extractBearerToken('bearer token=='), 'token==')
    assert.equal(extractBearerToken('Basic abc'), null)
    assert.equal(extractBearerToken('Bearer'), null)
    assert.equal(extractBearerToken('Bearer token extra'), null)
    assert.equal(extractBearerToken(undefined), null)
})
