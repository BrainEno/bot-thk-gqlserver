import path from 'path'
import { buildSchemaSync } from 'type-graphql'

import { authChecker } from '../middlewares/authChecker'
import { typeGraphqlPubSub } from '../topic'
import AuthResolvers from '../resolvers/AuthResolvers'
import BlogResolvers from '../resolvers/BlogResolvers'
import CatResolvers from '../resolvers/CatResolvers'
import UserResolvers from '../resolvers/UserResolvers'
import { Types } from 'mongoose'
import { ObjectIdScalar } from './ObjectIdScalar'
import TagResolvers from '../resolvers/TagResolvers'
import ConversationResolvers from '../resolvers/ConversationResolvers'
import MessageResolvers from '../resolvers/MessageResolvers'
import LikeResolvers from '../resolvers/LikeResolvers'
import CommentResolvers from '../resolvers/CommentResolvers'


export const createSchema = () =>
    buildSchemaSync({
        pubSub: typeGraphqlPubSub,
        resolvers: [
            AuthResolvers,
            UserResolvers,
            BlogResolvers,
            CatResolvers,
            TagResolvers,
            ConversationResolvers,
            MessageResolvers,
            LikeResolvers,
            CommentResolvers,
        ],
        authChecker: authChecker,
        authMode: 'null',
        emitSchemaFile:
            process.env.NODE_ENV === 'development'
                ? {
                      path: path.resolve(__dirname, '../schemas/schema.graphql'),
                      sortedSchema: false,
                  }
                : false,
        scalarsMap: [{ type: Types.ObjectId, scalar: ObjectIdScalar }],
    })
