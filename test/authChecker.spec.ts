import assert from 'node:assert/strict'
import test from 'node:test'
import { authChecker } from '../src/middlewares/authChecker'
import { TContext } from '../src/types'

test('requires an authenticated user even when no role is specified', () => {
    const anonymous = { user: null } as unknown as TContext
    const authenticated = {
        user: { _id: 'user-1', name: 'A', role: '0', username: 'a', tokenVersion: 0 },
    } as unknown as TContext

    const data = (context: TContext) => ({ context }) as never

    assert.equal(authChecker(data(anonymous), []), false)
    assert.equal(authChecker(data(authenticated), []), true)
    assert.equal(authChecker(data(authenticated), ['1']), false)
    assert.equal(authChecker(data(authenticated), ['0']), true)
})
