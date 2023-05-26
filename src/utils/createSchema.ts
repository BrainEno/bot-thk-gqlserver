import path from "path";
import { buildSchemaSync } from "type-graphql";
import { Container } from "typedi";

import { authChecker } from "../middlewares/authChecker";
import AuthResolvers from "../resolvers/AuthResolvers";
import BlogResolvers from "../resolvers/BlogResolvers";
import CatResolvers from "../resolvers/CatResolvers";
import UserResolvers from "../resolvers/UserResolvers";
import { ObjectId } from "mongodb";
import { ObjectIdScalar } from "./ObjectIdScalar";
import TagResolvers from "../resolvers/TagResolvers";

export const createSchema = () =>
  buildSchemaSync({
    resolvers: [
      AuthResolvers,
      UserResolvers,
      BlogResolvers,
      CatResolvers,
      TagResolvers,
    ],
    authChecker: authChecker,
    authMode: "null",
    emitSchemaFile: {
      path: path.resolve(__dirname, "../schemas/schema.gql"),
      sortedSchema: false,
    },
    // globalMiddlewares: [TypegooseMiddleware],
    scalarsMap: [{ type: ObjectId, scalar: ObjectIdScalar }],
    container: ({ context }) => Container.of(context.requestId),
  });
