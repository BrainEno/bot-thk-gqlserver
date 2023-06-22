import 'reflect-metadata';

import { ApolloServerPluginDrainHttpServer } from 'apollo-server-core';
import { ApolloServer } from 'apollo-server-express';
import dotenv from 'dotenv';
import express from 'express';
import http from 'http';
import mongoose from 'mongoose';
import { InMemoryLRUCache } from '@apollo/utils.keyvaluecache';

import { createSchema } from './utils/createSchema';
import {
  ApolloServerPlugin,
  GraphQLRequestContext,
} from 'apollo-server-plugin-base';
import Container, { ContainerInstance } from 'typedi';
import {
  getComplexity,
  simpleEstimator,
  fieldExtensionsEstimator,
} from 'graphql-query-complexity';
import cookieParser from 'cookie-parser';
import { TContext } from './types';
import cors from 'cors';
import { context } from './context/typeGraphQLContext';

dotenv.config();

const corsOptions = {
  origin: [
    process.env.CLIENT_URL as string,
    'https://studio.apollographql.com',
    'https://sendgrid.com',
  ],
  credentials: true,
};

const main = async () => {
  const port = parseInt(process.env.PORT!, 10) || 4001;
  const app = express();

  app.use(cookieParser());
  app.use(cors(corsOptions));

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
      .connect(process.env.MONGODB_URI!)
      .then(() => console.log('***MongoDB connected***'));
  } catch (error) {
    console.log('Error connecting to MongoDB:', error?.message);
  }

  const schema = createSchema();

  const apolloServer = new ApolloServer({
    schema,
    context,
    csrfPrevention: true,
    introspection: true,
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
            });
            if (complexity > 35) {
              throw new Error(
                `Sorry, too complicated query! ${complexity} is over 35 that is the max allowed complexity.`
              );
            }
            console.log('Used query complexity points:', complexity);
          },
          willSendResponse(requestContext: GraphQLRequestContext<TContext>) {
            Container.reset(requestContext.context.requestId.toString());

            const instancesIds = (
              (Container as any).instances as ContainerInstance[]
            ).map((instance) => instance.id);
            console.log('instances left in memory:', instancesIds);
          },
        }),
      },
    ] as ApolloServerPlugin[],
  });

  await apolloServer.start();

  apolloServer.applyMiddleware({
    app,
    cors: corsOptions,
    path: '/graphql',
  });

  await new Promise((resolve) => httpServer.listen({ port }, resolve as any));

  console.log(
    `🚀 Apollo server ready at http://localhost:${port}${apolloServer.graphqlPath}`
  );
};

main();
