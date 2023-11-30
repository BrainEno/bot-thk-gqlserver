import { Field, ObjectType } from 'type-graphql'
import { PopulatedUser } from './conversations'
import { PopulatedComment } from './comment'
import { PopulatedTag } from './tag'
import { PopulatedCategory } from './category'

@ObjectType()
export class PopulatedBlog {
    @Field(() => String)
    readonly _id: string

    @Field()
    title: string

    @Field()
    slug: string

    @Field()
    description: string

    @Field()
    body: string

    @Field()
    mtitle: string

    @Field({
        defaultValue:
            'https://res.cloudinary.com/hapmoniym/image/upload/v1644331126/bot-thk/no-image_eaeuge.jpg',
    })
    imageUri: string

    @Field({ defaultValue: false })
    active: boolean

    @Field(() => [PopulatedUser], { defaultValue: [] })
    likedBy: PopulatedUser[]

    @Field(() => [PopulatedComment], { defaultValue: [] })
    comments: PopulatedComment[]

    @Field(() => [PopulatedCategory], { defaultValue: [] })
    categories: PopulatedCategory[]

    @Field(() => [PopulatedTag], { defaultValue: [] })
    tags: PopulatedTag[]

    @Field(() => PopulatedUser)
    author: PopulatedUser

    @Field(() => Date)
    createdAt: Date

    @Field(() => Date)
    updatedAt?: Date
}

@ObjectType()
export class PopulatedCardBlog {
    @Field(() => String)
    readonly _id: string

    @Field()
    title: string

    @Field()
    slug: string

    @Field({
        defaultValue:
            'https://res.cloudinary.com/hapmoniym/image/upload/v1644331126/bot-thk/no-image_eaeuge.jpg',
    })
    imageUri: string

    @Field(() => PopulatedUser)
    author: PopulatedUser

    @Field(() => [PopulatedTag])
    tags: PopulatedTag[]

    @Field()
    description: string

    @Field(() => Date)
    createdAt: Date
}

@ObjectType()
export class NewBlogResponse {
    @Field()
    readonly success: boolean

    @Field(() => PopulatedCardBlog, { nullable: true })
    blog: PopulatedCardBlog | null
}
