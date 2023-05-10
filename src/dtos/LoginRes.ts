import { Field,  ObjectType } from 'type-graphql'


@ObjectType()
export class LoginRes {
    @Field()
    accessToken: string
}
