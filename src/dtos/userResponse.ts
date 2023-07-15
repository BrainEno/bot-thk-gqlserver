import { Field, ObjectType } from 'type-graphql';

@ObjectType()
export class UserResponse {
  @Field()
  ok: boolean;

  @Field()
  accessToken: string;
}
