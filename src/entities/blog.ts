import { modelOptions, prop, Ref } from '@typegoose/typegoose'
import { MinLength } from 'class-validator'
import { Field, InputType, ObjectType } from 'type-graphql'
import { Category } from './category'
import { Comment } from './comment'
import { Tag } from './tag'
import { ObjectIdScalar as ObjectId } from '../utils/ObjectIdScalar'
import { ObjectId as ObjectID } from 'mongoose'
import { User } from './user'
import { TimeStamps } from '@typegoose/typegoose/lib/defaultClasses'

@ObjectType()
@modelOptions({
    schemaOptions: {
        toJSON: { virtuals: true },
        toObject: { virtuals: true },
    },
})
export class Blog extends TimeStamps {
    @Field(() => ObjectId)
    readonly _id: ObjectID

    @prop({
        type: () => String,
        trim: true,
        required: true,
        minlength: 1,
        maxlength: 50,
    })
    @Field()
    @MinLength(1, { message: '标题不得为空' })
    title: string

    @prop({ type: () => String })
    @Field()
    slug: string

    @prop({ type: () => String, required: false, maxlength: 300, trim: true })
    @Field()
    description?: string

    @prop({ type: () => String, required: true })
    @Field({ nullable: false })
    @MinLength(50)
    body: string

    @prop({ type: () => String, required: false })
    @Field()
    mtitle: string

    @prop({ type: () => String, required: false })
    @Field({
        defaultValue:
            'https://res.cloudinary.com/hapmoniym/image/upload/v1644331126/bot-thk/no-image_eaeuge.jpg',
    })
    imageUri?: string

    @prop({ type: () => Boolean, default: false })
    @Field({ defaultValue: false })
    active: boolean

    @prop({ autopopulate: true, ref: 'User', default: [] as Ref<User>[] })
    @Field(() => [User], { defaultValue: [] as Ref<User>[] })
    likedBy?: Ref<User>[]

    @prop({ autopopulate: true, ref: 'Comment', default: [] as Ref<Comment>[] })
    @Field(() => [Comment], { defaultValue: [] })
    comments?: Ref<Comment>[]

    @prop({ autopopulate: true, ref: () => Category })
    @Field(() => [Category])
    categories: Ref<Category>[]

    @prop({ autopopulate: true, ref: () => Tag })
    @Field(() => [Tag])
    tags: Ref<Tag>[]

    @Field(() => User)
    @prop({ ref: () => User, required: true })
    public author: Ref<User>

    @Field(() => Date)
    createdAt: Date

    @Field(() => Date)
    updatedAt?: Date
}

@InputType()
export class BlogInput {
    @Field()
    @MinLength(1, { message: '标题不得为空' })
    title: string

    @Field({ nullable: false })
    @MinLength(50)
    body: string

    @Field({
        defaultValue:
            'https://res.cloudinary.com/hapmoniym/image/upload/v1644331126/bot-thk/no-image_eaeuge.jpg',
        nullable: true,
    })
    imageUri?: string

    @Field()
    active: boolean
}
