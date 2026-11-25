import 'reflect-metadata'

import {
    ApolloServerPluginDrainHttpServer,
    ApolloServerPluginLandingPageDisabled,
    ApolloServerPluginLandingPageLocalDefault,
} from 'apollo-server-core'
import { ApolloServer } from 'apollo-server-express'
import dotenv from 'dotenv'
import express from 'express'
import http from 'http'
import mongoose from 'mongoose'
import { InMemoryLRUCache } from '@apollo/utils.keyvaluecache'
import { createHandler } from 'graphql-sse/lib/use/express'

import { createSchema } from './utils/createSchema'
import {
    ApolloServerPlugin,
    GraphQLRequestContext,
} from 'apollo-server-plugin-base'
import {
    getComplexity,
    simpleEstimator,
    fieldExtensionsEstimator,
} from 'graphql-query-complexity'
import cookieParser from 'cookie-parser'
import { TContext } from './types'
import cors from 'cors'
import { context, getDynamicContext } from './context/typeGraphQLContext'
import { LogService } from './services/LogService'
import { ArgumentValidationError } from 'type-graphql'
// import imagesRoutes from './api/images/routes'

dotenv.config({ debug: process.env.NODE_ENV === 'development' })

const corsOptions = {
    origin: [
        process.env.CLIENT_URL as string,
        'https://studio.apollographql.com',
        'https://sendgrid.com',
    ],
    credentials: true,
}

const MONGODB_URI = process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017'
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
    const port = parseInt(process.env.PORT!, 10) || 4001
    const schema = createSchema()

    const handler = createHandler<Partial<TContext>>({
        schema,
        context: async (req) => getDynamicContext(req),
    })
    const app = express()

    app.use(cookieParser())
    app.use(express.json())
    app.use(cors(corsOptions))
    app.use('/graphql/stream', async (req, res) => {
        try {
            await handler(req, res)
        } catch {
            logger.error('GraphQL SSE handler failed')
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
    // app.use('/api/images', imagesRoutes)

    const httpServer = http.createServer(app)

    await mongoose.connect(MONGODB_URI)
    logger.log('MongoDB connected')

    const apolloServer = new ApolloServer({
        schema,
        context,
        formatError: (error) => {
            if (error instanceof ArgumentValidationError) {
                logger.warn('GraphQL argument validation failed')
                return error
            }
            if (error.extensions.code === 'INTERNAL_SERVER_ERROR') {
                logger.error('GraphQL request failed')
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
            {
                requestDidStart: () => ({
                    //query complexity
                    didResolveOperation({
                        request,
                        document,
                    }: GraphQLRequestContext<TContext>) {
                        const complexity = getComplexity({
                            schema,
                            operationName: request.operationName,
                            query: document!,
                            variables: request.variables,
                            estimators: [
                                fieldExtensionsEstimator(),
                                simpleEstimator({ defaultComplexity: 1 }),
                            ],
                        })
                        if (complexity > 40) {
                            throw new Error(
                                `Sorry, too complicated query! ${complexity} is over 40 that is the max allowed complexity.`
                            )
                        }
                        if (complexity > 0)
                            logger.log(
                                `Used query complexity points: ${complexity}`
                            )
                    },
                }),
            },
            ...(process.env.NODE_ENV === 'development'
                ? [ApolloServerPluginLandingPageLocalDefault({ embed: true })]
                : [ApolloServerPluginLandingPageDisabled()]),
        ] as ApolloServerPlugin[],
    })

    await apolloServer.start()

    apolloServer.applyMiddleware({
        app,
        cors: corsOptions,
        path: '/graphql',
    })

    await new Promise<void>((resolve, reject) => {
        httpServer.once('error', reject)
        httpServer.listen(port, '0.0.0.0', () => {
            httpServer.removeListener('error', reject)
            resolve()
        })
    })

    logger.log(`Apollo server ready on port ${port}`)

    let shuttingDown = false
    const shutdown = async () => {
        if (shuttingDown) return
        shuttingDown = true
        try {
            await apolloServer.stop()
            await mongoose.disconnect()
            logger.log('Server shutdown complete')
        } catch {
            logger.error('Server shutdown failed')
            process.exitCode = 1
        }
    }

    process.once('SIGINT', () => void shutdown())
    process.once('SIGTERM', () => void shutdown())
}

main().catch(() => {
    console.error('Server startup failed')
    process.exitCode = 1
})
