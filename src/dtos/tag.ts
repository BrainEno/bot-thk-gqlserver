import { Field, ObjectType } from 'type-graphql'

@ObjectType()
export class PopulatedTag {
    @Field()
    _id?: string

    @Field()
    slug: string

    @Field()
    name: string
}
