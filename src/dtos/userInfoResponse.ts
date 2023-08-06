import { ObjectType, Field } from 'type-graphql';

@ObjectType()
export class UserInfoResponse {
  @Field()
  _id: string;

  @Field()
  username: string;

  @Field()
  name: string;

  @Field()
  email: string;

  @Field()
  about: string;

  @Field()
  photo: string;

  @Field(() => Date)
  createdAt: Date;
}
