import 'dotenv/config'
import 'reflect-metadata'
import { randomUUID } from 'node:crypto'

import { ApolloServer, type ApolloServerPlugin } from '@apollo/server'
import { ApolloServerPluginLandingPageDisabled } from '@apollo/server/plugin/disabled'
import { ApolloServerPluginDrainHttpServer } from '@apollo/server/plugin/drainHttpServer'
import { ApolloServerPluginLandingPageLocalDefault } from '@apollo/server/plugin/landingPage/default'
import { expressMiddleware } from '@as-integrations/express5'
import { InMemoryLRUCache } from '@apollo/utils.keyvaluecache'
import { createHandler } from 'graphql-sse/lib/use/express'
import { GraphQLError } from 'graphql'
import cookieParser from 'cookie-parser'
import cors from 'cors'
import express from 'express'
import http from 'http'
import mongoose from 'mongoose'
import {
    fieldExtensionsEstimator,
    getComplexity,
    simpleEstimator,
} from 'graphql-query-complexity'
import { ArgumentValidationError } from 'type-graphql'

import { context, getDynamicContext } from './context/typeGraphQLContext'
import { LogService, logFailure, requestContext } from './services/LogService'
import { TContext } from './types'
import { createSchema } from './utils/createSchema'

const corsOptions = {
    origin: [
        ...(process.env.CLIENT_URL ? [process.env.CLIENT_URL] : []),
        'https://studio.apollographql.com',
        'https://sendgrid.com',
    ],
    credentials: true,
    exposedHeaders: ['x-request-id'],
}

const MONGODB_URI = process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017/bot-thk'
const REQUIRED_SECRET_NAMES = [
    'ACCESS_TOKEN_SECRET',
    'REFRESH_TOKEN_SECRET',
    'JWT_RESET_PASSWORD',
] as const

const main = async () => {
    for (const name of REQUIRED_SECRET_NAMES) {
        const value = process.env[name]
        if (!value || value.length < 32 || value.startsWith('replace-with-')) {
            throw new Error('Required application secrets are missing or weak')
        }
    }

    const logger = new LogService()
    const parsedPort = Number.parseInt(process.env.PORT ?? '4001', 10)
    const port = Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort <= 65_535
        ? parsedPort
        : 4001
    const schema = createSchema()
    const handler = createHandler<Partial<TContext>>({
        schema,
        context: async (req) => getDynamicContext(req),
    })
    const app = express()

    app.use((_req, res, next) => {
        const requestId = randomUUID()
        res.locals.requestId = requestId
        res.setHeader('x-request-id', requestId)
        requestContext.run({ requestId }, next)
    })
    app.use(cookieParser())
    app.use(express.json())
    app.use(cors(corsOptions))
    app.use('/graphql/stream', async (req, res) => {
        try {
            await handler(req, res)
        } catch (error) {
            logFailure('graphql.sse.handler.failed', error)
            if (!res.headersSent) res.status(500).end()
        }
    })

    app.get('/healthz', (_req, res) => {
        res.status(200).json({ status: 'ok' })
    })

    app.get('/readyz', (_req, res) => {
        const ready = mongoose.connection.readyState === 1
        res.status(ready ? 200 : 503).json({
            status: ready ? 'ready' : 'not-ready',
        })
    })

    app.get('/', (_req, res) => {
        res.status(200).json({ uptime: process.uptime(), message: 'OK' })
    })

    const httpServer = http.createServer(app)

    await mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 5_000 })
    logger.log('mongodb.connected')

    const complexityPlugin: ApolloServerPlugin<TContext> = {
        async requestDidStart({ request }) {
            const startedAt = performance.now()
            const operationName = request.operationName?.slice(0, 100) ?? 'anonymous'
            return {
                async willSendResponse({ response, contextValue }) {
                    const errorCount = response.body.kind === 'single'
                        ? response.body.singleResult.errors?.length ?? 0
                        : 0
                    logger.log('graphql.operation.completed', {
                        operationName,
                        requestId: contextValue.requestId,
                        durationMs: Math.round(performance.now() - startedAt),
                        errorCount,
                    })
                },
                async didResolveOperation({ request, document, contextValue }) {
                    const complexity = getComplexity({
                        schema,
                        operationName: request.operationName,
                        query: document,
                        variables: request.variables,
                        estimators: [
                            fieldExtensionsEstimator(),
                            simpleEstimator({ defaultComplexity: 1 }),
                        ],
                    })
                    if (complexity > 40) {
                        throw new GraphQLError('GraphQL query exceeds the complexity limit', {
                            extensions: { code: 'QUERY_TOO_COMPLEX' },
                        })
                    }
                    if (complexity > 0) {
                        logger.log('graphql.query.complexity', {
                            complexity,
                            requestId: contextValue.requestId,
                            operationName,
                        })
                    }
                },
            }
        },
    }

    const apolloServer = new ApolloServer<TContext>({
        schema,
        formatError: (error) => {
            if (error instanceof ArgumentValidationError) {
                logger.warn('graphql.argument_validation_failed')
                return error
            }
            if (error.extensions?.code === 'INTERNAL_SERVER_ERROR') {
                logger.error('graphql.request.failed', { code: error.extensions?.code })
                return {
                    message: 'Internal server error',
                    locations: error.locations,
                    path: error.path,
                    extensions: { code: 'INTERNAL_SERVER_ERROR' },
                }
            }
            return error
        },
        csrfPrevention: true,
        introspection: process.env.NODE_ENV !== 'production',
        cache: new InMemoryLRUCache({
            maxSize: Math.pow(2, 20) * 100,
            ttl: 300_000,
        }),
        plugins: [
            ApolloServerPluginDrainHttpServer({ httpServer }),
            complexityPlugin,
            ...(process.env.NODE_ENV === 'development'
                ? [ApolloServerPluginLandingPageLocalDefault({ embed: true })]
                : [ApolloServerPluginLandingPageDisabled()]),
        ] as ApolloServerPlugin[],
    })

    await apolloServer.start()
    app.use(
        '/graphql',
        expressMiddleware(apolloServer, {
            context: async ({ req, res }) => context({ req, res }),
        })
    )

    await new Promise<void>((resolve, reject) => {
        httpServer.once('error', reject)
        httpServer.listen(port, '0.0.0.0', () => {
            httpServer.removeListener('error', reject)
            resolve()
        })
    })

    logger.log('http.server.ready', { port })

    let shuttingDown = false
    const shutdown = async () => {
        if (shuttingDown) return
        shuttingDown = true
        try {
            await apolloServer.stop()
            await mongoose.disconnect()
            logger.log('server.shutdown.completed')
        } catch (error) {
            logFailure('server.shutdown.failed', error)
            process.exitCode = 1
        }
    }

    process.once('SIGINT', () => void shutdown())
    process.once('SIGTERM', () => void shutdown())
}

main().catch((error: unknown) => {
    logFailure('server.startup.failed', error)
    process.exitCode = 1
})
