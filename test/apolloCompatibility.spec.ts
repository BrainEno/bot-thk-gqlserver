import assert from 'node:assert/strict'
import test from 'node:test'
import { ApolloServer } from '@apollo/server'
import { createSchema } from '../src/utils/createSchema'
import { TContext } from '../src/types'

test('Apollo Server 5 executes against the TypeGraphQL-built schema', async () => {
    const server = new ApolloServer<Partial<TContext>>({
        schema: createSchema(),
    })

    await server.start()
    try {
        const response = await server.executeOperation(
            { query: 'query RuntimeCompatibility { __typename }' },
            { contextValue: { user: null } }
        )

        assert.equal(response.body.kind, 'single')
        if (response.body.kind !== 'single') return
        assert.equal(response.body.singleResult.data?.__typename, 'Query')
    } finally {
        await server.stop()
    }
})
