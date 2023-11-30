import { getModelForClass, prop, Ref } from '@typegoose/typegoose'
import { TimeStamps } from '@typegoose/typegoose/lib/defaultClasses'
import { ObjectIdScalar as ObjectId } from '../utils/ObjectIdScalar'
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

    @prop({ ref: 'User' })
    @Field(() => User)
    by: Ref<User>

    @prop({ ref: 'Blog' })
    @Field(() => Blog, { nullable: true })
    atBlog?: Ref<Blog>

    @prop({ ref: 'Comment' })
    @Field(() => Comment, { nullable: true })
    replyTo?: Ref<Comment>

    @prop({ ref: 'Comment' })
    @Field(() => [Comment])
    replies: Ref<Comment>[]

    @Field(() => Date)
    createdAt: Date

    @Field(() => Date, { nullable: true })
    updatedAt?: Date
}

export const CommentModel = getModelForClass(Comment, {
    schemaOptions: {
        collection: 'comments',
        timestamps: true,
    },
})
