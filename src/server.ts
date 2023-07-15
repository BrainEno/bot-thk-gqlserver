import 'reflect-metadata';

import {
  ApolloServerPluginDrainHttpServer,
  ApolloServerPluginInlineTrace,
  ApolloServerPluginLandingPageLocalDefault,
} from 'apollo-server-core';
import { ApolloServer } from 'apollo-server-express';
import dotenv from 'dotenv';
import express from 'express';
import http from 'http';
import mongoose from 'mongoose';
import { InMemoryLRUCache } from '@apollo/utils.keyvaluecache';
import { createHandler } from 'graphql-sse/lib/use/express';

import { createSchema } from './utils/createSchema';
import {
  ApolloServerPlugin,
  GraphQLRequestContext,
} from 'apollo-server-plugin-base';
import {
  getComplexity,
  simpleEstimator,
  fieldExtensionsEstimator,
} from 'graphql-query-complexity';
import cookieParser from 'cookie-parser';
import { TContext } from './types';
import cors from 'cors';
import { context } from './context/typeGraphQLContext';
import { LogService } from './services/LogService';
import { ArgumentValidationError } from 'type-graphql';

dotenv.config({ debug: process.env.NODE_ENV === 'development' });

const corsOptions = {
  origin: [
    process.env.CLIENT_URL as string,
    'https://studio.apollographql.com',
    'https://sendgrid.com',
  ],
  credentials: true,
};

const MONGODB_URI = process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017';

const main = async () => {
  const logger = new LogService();
  const port = parseInt(process.env.PORT!, 10) || 4001;
  const schema = createSchema();

  const handler = createHandler({ schema });
  const app = express();

  app.use(cookieParser());
  app.use(cors(corsOptions));
  app.use('/graphql/stream', handler);

  app.get('/', (_req, res) => {
    const data = {
      uptime: process.uptime(),
      message: 'OK',
      date: new Date(),
    };
    res.status(200).send(data);
  });

  const httpServer = http.createServer(app);

  try {
    mongoose
      .connect(MONGODB_URI)
      .then(() => logger.log('***MongoDB connected***'));
  } catch (error) {
    console.log('Error connecting to MongoDB:', error?.message);
  }

  const apolloServer = new ApolloServer({
    schema,
    context,
    formatError: (error) => {
      if (error instanceof ArgumentValidationError) {
        console.log('ValidationError: ', error.message, error.originalError);
      }
      return error;
    },
    csrfPrevention: true,
    introspection: true,
    cache: new InMemoryLRUCache({
      maxSize: Math.pow(2, 20) * 100,
      ttl: 300_000,
    }),
    plugins: [
      ApolloServerPluginDrainHttpServer({ httpServer }),
      ApolloServerPluginInlineTrace(),
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
            });
            if (complexity > 35) {
              throw new Error(
                `Sorry, too complicated query! ${complexity} is over 35 that is the max allowed complexity.`
              );
            }
            if (complexity > 0)
              logger.log(`Used query complexity points: ${complexity}`);
          },
        }),
      },
      ApolloServerPluginLandingPageLocalDefault({ embed: true }),
    ] as ApolloServerPlugin[],
  });

  await apolloServer.start();

  apolloServer.applyMiddleware({
    app,
    cors: corsOptions,
    path: '/graphql',
  });

  await new Promise((resolve) => httpServer.listen({ port }, resolve as any));

  logger.log(
    `🚀 Apollo server ready at http://localhost:${port}${apolloServer.graphqlPath}`
  );
};

main();
