import path from 'path';
import { buildSchemaSync } from 'type-graphql';

import { authChecker } from '../middlewares/authChecker';
import AuthResolvers from '../resolvers/AuthResolvers';
import BlogResolvers from '../resolvers/BlogResolvers';
import CatResolvers from '../resolvers/CatResolvers';
import UserResolvers from '../resolvers/UserResolvers';
import { ObjectId } from 'mongodb';
import { ObjectIdScalar } from './ObjectIdScalar';
import TagResolvers from '../resolvers/TagResolvers';
import { RedisPubSub } from 'graphql-redis-subscriptions';
import Redis, { RedisOptions } from 'ioredis';
import dotenv from 'dotenv';
import ConversationResolvers from '../resolvers/ConversationResolvers';
import MessageResolvers from '../resolvers/MessageResolvers';

dotenv.config();

const options: RedisOptions = {
  host: process.env.REDIS_HOST,
  port: Number.parseInt(process.env.REDIS_PORT!),
  password: process.env.REDIS_PASSWORD,
  retryStrategy: (times) => Math.max(times * 100, 3000),
};

const pubSub = new RedisPubSub({
  publisher: new Redis(options),
  subscriber: new Redis(options),
});

export const createSchema = () =>
  buildSchemaSync({
    resolvers: [
      AuthResolvers,
      UserResolvers,
      BlogResolvers,
      CatResolvers,
      TagResolvers,
      ConversationResolvers,
      MessageResolvers,
    ],
    pubSub,
    authChecker: authChecker,
    authMode: 'null',
    emitSchemaFile: {
      path: path.resolve(__dirname, '../schemas/schema.graphql'),
      sortedSchema: false,
    },
    scalarsMap: [{ type: ObjectId, scalar: ObjectIdScalar }],
    // container: Container,
  });
