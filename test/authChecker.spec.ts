import assert from 'node:assert/strict'
import test from 'node:test'
import { checkUserRole } from '../src/middlewares/authChecker'
import { TContext } from '../src/types'

test('requires an authenticated user even when no role is specified', () => {
    const anonymous = { user: null } as unknown as TContext
    const authenticated = {
        user: { _id: 'user-1', name: 'A', role: '0', username: 'a', tokenVersion: 0 },
    } as unknown as TContext

    const data = (context: TContext) => ({ context }) as never

    assert.equal(checkUserRole(data(anonymous), []), false)
    assert.equal(checkUserRole(data(authenticated), []), true)
    assert.equal(checkUserRole(data(authenticated), ['1']), false)
    assert.equal(checkUserRole(data(authenticated), ['0']), true)
})
