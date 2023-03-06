import { prop, Ref } from '@typegoose/typegoose'
import { Min, MinLength } from 'class-validator'
import { Field, InputType, ObjectType } from 'type-graphql'
import { Category } from './category'
import { Comment } from './comment'
import { Tag } from './tag'
import { ObjectId } from 'mongodb'
import { User } from './user'

@ObjectType()
export class Blog {
    @Field(() => ObjectId)
    readonly _id: ObjectId

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

    @prop({ type: () => String, unique: true, index: true })
    @Field()
    slug: string

    @prop({ type: () => String, required: false, maxlength: 100 })
    @Field({ nullable: true })
    description?: string

    @prop({ type: () => String, required: true })
    @Field({ nullable: false })
    @Min(50)
    body: string

    @prop({ type: () => String, required: false })
    @Field()
    mtitle: string

    @prop({ type: () => String, required: false })
    @Field({ nullable: true })
    image?: string

    @prop({ type: () => String, required: false })
    @Field({
        defaultValue:
            'https://res.cloudinary.com/hapmoniym/image/upload/v1644331126/bot-thk/no-image_eaeuge.jpg',
        nullable: true,
    })
    imageUri?: string

    @prop({ type: () => Boolean, default: false })
    @Field({ defaultValue: false })
    active: boolean

    @prop({ autopopulate: true, ref: 'User', default: [] as Ref<User>[] })
    @Field(() => [User], { defaultValue: [] as Ref<User>[] })
    likedBy?: Ref<User>[]

    @prop({ autopopulate: true, ref: 'Comment', default: [] })
    @Field(() => [Comment], { defaultValue: [] })
    comments?: Ref<Comment>[]

    @prop({ autopopulate: true, ref: 'Category' })
    @Field(() => [Category])
    categories: Ref<Category>[]

    @prop({ autopopulate: true, ref: 'Tag' })
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

    @Field()
    slug: string

    @Field({ nullable: true })
    description?: string

    @Field({ nullable: false })
    @Min(50)
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
