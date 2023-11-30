import { Field, ObjectType } from 'type-graphql'
import { PopulatedUser } from './conversations'
import { PopulatedBlog } from './blogs'

@ObjectType()
export class PopulatedComment {
    @Field()
    _id: string

    @Field()
    content: string

    @Field(() => PopulatedUser)
    by: PopulatedUser

    @Field(() => PopulatedBlog)
    atBlog: PopulatedBlog
}
