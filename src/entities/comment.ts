import { getModelForClass, prop, Ref } from '@typegoose/typegoose'
import { TimeStamps } from '@typegoose/typegoose/lib/defaultClasses'
import { ObjectId } from 'bson'
import { ObjectId as ObjectID } from 'mongoose'
import { Field, ObjectType } from 'type-graphql'

import { Blog } from './blog'
import { User } from './user'

@ObjectType()
export class Comment extends TimeStamps {
    @Field(() => ObjectId)
    readonly _id: ObjectID

    @prop({ nullable: false })
    @Field({ nullable: false })
    content: string

    @prop({ ref: 'User', foreignField: 'comments', localField: 'username' })
    @Field(() => User)
    by: Ref<User>

    @prop({ ref: 'Blog', foreignField: 'comments', localField: 'blogId' })
    @Field(() => Blog)
    atBlog: Ref<Blog>

}

export const CommentModel = getModelForClass(Comment, {
    schemaOptions: {
        collection: 'comments',
        timestamps: true,
    },
})
