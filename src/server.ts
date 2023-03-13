import "reflect-metadata";

import { ApolloServerPluginDrainHttpServer } from "apollo-server-core";
import { ApolloServer } from "apollo-server-express";
import dotenv from "dotenv";
import express, { Request, Response, NextFunction } from "express";
import http from "http";
import mongoose from "mongoose";

import { createSchema } from "./utils/createSchema";
// import getEnveloped from "./src/envelop/getEnveloped";
import { context } from "./context/typeGraphQLContext";
import {
  ApolloServerPlugin,
  GraphQLRequestContext,
} from "apollo-server-plugin-base";
import Container, { ContainerInstance } from "typedi";
import {
  getComplexity,
  simpleEstimator,
  fieldExtensionsEstimator,
} from "graphql-query-complexity";
import cookieParser from "cookie-parser";
import { TContext } from "./types";
import cors from "cors";

const main = async () => {
  dotenv.config();
  const port = parseInt(process.env.PORT!, 10) || 4001;
  const app = express();
  const router = express.Router();

  router.use((_req: Request, res: Response, next: NextFunction) => {
    res.header("Access-Control-Allow-Methods", "GET");
    next();
  });

  router.get("health", (_req, res) => {
    const data = {
      uptime: process.uptime(),
      message: "OK",
      date: new Date(),
    };
    res.status(200).send(data);
  });

  app.use(cookieParser());
  app.use(cors({ origin: "*" }));

  const httpServer = http.createServer(app);

  try {
    mongoose
      .connect(process.env.MONGODB_URI!)
      .then(() => console.log("***MongoDB connected***"));
  } catch (error) {
    console.log("Error connecting to MongoDB:", error?.message);
  }

  const schema = await createSchema();

  const apolloServer = new ApolloServer({
    schema,
    context,
    // executor: async (requestContext) => {
    //   const { schema, execute, contextFactory } = getEnveloped({
    //     req: requestContext.request.http,
    //   });

    //   return execute({
    //     schema,
    //     document: requestContext.document,
    //     contextValue: await contextFactory(),
    //     variableValues: requestContext.request.variables,
    //     operationName: requestContext.operationName,
    //   });
    // },
    csrfPrevention: true,
    introspection: true,
    cache: "bounded",
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
            console.log("Used query complexity points:", complexity);
          },
          willSendResponse(requestContext: GraphQLRequestContext<TContext>) {
            Container.reset(requestContext.context.requestId.toString());

            const instancesIds = (
              (Container as any).instances as ContainerInstance[]
            ).map((instance) => instance.id);
            console.log("instances left in memory:", instancesIds);
          },
        }),
      },
    ] as ApolloServerPlugin[],
  });

  await apolloServer.start();

  apolloServer.applyMiddleware({ app, cors: false, path: "/graphql" });

  await new Promise((resolve) => httpServer.listen({ port }, resolve as any));

  console.log(
    `🚀 Apollo server ready at http://localhost:${port}${apolloServer.graphqlPath}`
  );
};

main();
