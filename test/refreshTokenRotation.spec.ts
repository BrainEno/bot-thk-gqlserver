import assert from 'node:assert/strict'
import test from 'node:test'
import jwt from 'jsonwebtoken'
import { Types } from 'mongoose'
import { User } from '../src/entities/user'
import { UserModel } from '../src/models'
import AuthResolvers from '../src/resolvers/AuthResolvers'

test('refresh tokens are atomically single-use, including concurrent replays', async () => {
    const refreshSecret = 'refresh-secret-for-test'
    const accessSecret = 'access-secret-for-test'
    const userId = new Types.ObjectId().toString()
    const initialVersion = 4
    let currentVersion = initialVersion
    const cookieWrites: string[] = []
    const model = UserModel as unknown as {
        findOneAndUpdate: (
            filter: { _id: string; tokenVersion: number },
            update: { $inc: { tokenVersion: number } },
            options: { new: boolean }
        ) => { exec: () => Promise<User | null> }
    }
    const originalFindOneAndUpdate = model.findOneAndUpdate
    const previousRefreshSecret = process.env.REFRESH_TOKEN_SECRET
    const previousAccessSecret = process.env.ACCESS_TOKEN_SECRET

    process.env.REFRESH_TOKEN_SECRET = refreshSecret
    process.env.ACCESS_TOKEN_SECRET = accessSecret
    model.findOneAndUpdate = (filter, update, options) => ({
        exec: async () => {
            assert.equal(filter._id, userId)
            assert.equal(options.new, true)
            if (filter.tokenVersion !== currentVersion) return null

            currentVersion += update.$inc.tokenVersion
            return {
                _id: new Types.ObjectId(userId),
                tokenVersion: currentVersion,
                name: 'Test User',
                username: 'test-user',
                role: '0',
            } as User
        },
    })

    try {
        const refreshToken = jwt.sign(
            { _id: userId, tokenVersion: initialVersion },
            refreshSecret,
            { expiresIn: '7d' }
        )
        const context = {
            res: {
                cookie(name: string) {
                    cookieWrites.push(name)
                },
            },
        } as never

        const resolver = new AuthResolvers()
        const results = await Promise.all([
            resolver.refreshToken(refreshToken, context),
            resolver.refreshToken(refreshToken, context),
        ])

        assert.equal(results.filter((result) => result.ok).length, 1)
        assert.equal(results.filter((result) => !result.ok).length, 1)
        assert.equal(currentVersion, initialVersion + 1)
        assert.deepEqual(cookieWrites.sort(), ['botthk', 'botthk_refresh'])

        const successfulResponse = results.find((result) => result.ok)
        assert.ok(successfulResponse)
        const rotatedPayload = jwt.verify(
            successfulResponse.refreshToken,
            refreshSecret
        ) as { tokenVersion: number }
        assert.equal(rotatedPayload.tokenVersion, initialVersion + 1)
    } finally {
        model.findOneAndUpdate = originalFindOneAndUpdate
        if (previousRefreshSecret === undefined) {
            delete process.env.REFRESH_TOKEN_SECRET
        } else {
            process.env.REFRESH_TOKEN_SECRET = previousRefreshSecret
        }
        if (previousAccessSecret === undefined) {
            delete process.env.ACCESS_TOKEN_SECRET
        } else {
            process.env.ACCESS_TOKEN_SECRET = previousAccessSecret
        }
    }
})
