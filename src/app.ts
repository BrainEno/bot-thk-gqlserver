import { createYoga } from "graphql-yoga";
import fastify, { FastifyReply, FastifyRequest } from "fastify";
import { createSchema } from "./utils/createSchema";
import jwt from "jsonwebtoken";
import { createInMemoryCache, useResponseCache } from "@envelop/response-cache";
import { useCookies } from "@whatwg-node/server-plugin-cookies";
import { useAPQ } from "@graphql-yoga/plugin-apq";

import { useGraphQlJit } from "@envelop/graphql-jit";
import { useMaskedErrors } from "@envelop/core";
import dotenv from "dotenv";
dotenv.config();

export const buildApp = (logging = true) => {
  const app = fastify({
    logger: logging && {
      transport: {
        target: "pino-pretty",
      },
      level: "debug",
    },
  });

  const schema = createSchema();
  const cache = createInMemoryCache();

  const yoga = createYoga<{
    req: FastifyRequest;
    reply: FastifyReply;
  }>({
    schema,
    context: async (contextSoFar) => {
      const { req } = contextSoFar;
      let user = null;
      if (req.headers["cookie"]) {
        user = jwt.decode(req.headers["cookie"].split("=")[1]);
      }
      console.log(req.headers);
      console.log(user);
      return { ...contextSoFar, user };
    },
    cors: {
      origin: ["http://localhost:3000", process.env.CLIENT_URL as string],
      credentials: true,
      methods: ["GET", "POST", "OPTIONS"],
    },
    logging: {
      debug: (...args) => args.forEach((arg) => app.log.debug(arg)),
      info: (...args) => args.forEach((arg) => app.log.info(arg)),
      warn: (...args) => args.forEach((arg) => app.log.warn(arg)),
      error: (...args) => args.forEach((arg) => app.log.error(arg)),
    },
    healthCheckEndpoint: "/live",
    plugins: [
      useResponseCache({
        cache,
        ttl: 60 * 1000 * 60,
        ttlPerType: {
          Blog: 500,
          Category: 500,
          Tag: 500,
        },
        ttlPerSchemaCoordinate: {
          "Query.getRelatedBlogs": 1000,
          "Query.listBlogsWithCatTag": 1000,
          "Query.getBlogBySlug": 500,
          "Query.getCatBlogs": 500,
          "Query.getTagBlogs": 500,
        },
        ignoredTypes: ["User"],
        session: () => null,
      }),
      useCookies(),
      useAPQ(),
      useGraphQlJit(),
      useMaskedErrors({ errorMessage: "Something went wrong." }),
    ],
  });

  app.route({
    url: "/graphql",
    method: ["GET", "PUT", "POST", "OPTIONS"],
    handler: async (req, reply) => {
      const response = await yoga.handleNodeRequest(req, {
        req,
        reply,
      });
      response.headers.forEach((value, key) => {
        reply.header(key, value);
      });

      reply.status(response.status);

      reply.send(response.body);

      return reply;
    },
  });

  return app;
};
