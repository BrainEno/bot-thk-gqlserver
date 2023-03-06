import { getModelForClass, prop, Ref } from '@typegoose/typegoose'
import { ObjectId } from 'mongodb'
import { Field, ObjectType } from 'type-graphql'

import { Blog } from './blog'
import { User } from './user'

@ObjectType()
export class Comment {
    @Field(() => ObjectId)
    readonly _id: ObjectId

    @prop({ nullable: false })
    @Field({ nullable: false })
    content: string

    @prop({ ref: 'User', foreignField: 'comments', localField: 'username' })
    @Field(() => User)
    by: Ref<User>

    @prop({ ref: 'Blog', foreignField: 'comments', localField: 'blogId' })
    @Field(() => Blog)
    atBlog: Ref<Blog>

    @Field(() => Date)
    createdAt: Date

    @Field(() => Date)
    updatedAt?: Date
}

export const CommentModel = getModelForClass(Comment, {
    schemaOptions: {
        collection: 'comments',
        timestamps: true,
    },
})
