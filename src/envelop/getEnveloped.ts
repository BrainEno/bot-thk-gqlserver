import dotenv from "dotenv";
import { envelop } from "@envelop/core";
import { useResponseCache, createInMemoryCache } from "@envelop/response-cache";
import { createRedisCache } from "@envelop/response-cache-redis";
import Redis from "ioredis";
import { TContext } from "../types";
import { useEngine, useSchema } from "@envelop/core";
import  GraphQLJS from "graphql";
import { createSchema } from "../utils/createSchema";

dotenv.config();

let cache = createInMemoryCache();

try {
  const redis = new Redis({
    host: process.env.REDIS_HOST as string,
    port: parseInt(process.env.REDIS_PORT!, 10) as number,
    username: "default",
    password: process.env.REDIS_PASSWORD as string,
  });
  cache = createRedisCache({ redis });
} catch (error) {
  console.log("error when connecting redis", error);
  cache = createInMemoryCache();
}

const getSchema = async () => {
  try {
    const schema = await createSchema();
    return schema;
  } catch (error) {
    return null;
  }
};

const getEnveloped = getSchema().then((schema) =>
  envelop({
    plugins: [
      useEngine(GraphQLJS),
      useSchema(schema),
      useResponseCache({
        cache,
        // cache operations for 1 hour by default
        ttl: 60 * 1000 * 60,
        ttlPerType: {
          // cache operation containing Stock object type for 500ms
          Stock: 500,
        },
        ttlPerSchemaCoordinate: {
          // cache operation containing Query.rocketCoordinates selection for 100ms
          "Query.rocketCoordinates": 100,
        },
        // never cache responses that include a RefreshToken object type.
        ignoredTypes: ["RefreshToken", "User", "Response"],
        session: (context: TContext) =>
          context.user ? String(context.user._id) : null,
      }),
    ],
  })
);

export default getEnveloped;
