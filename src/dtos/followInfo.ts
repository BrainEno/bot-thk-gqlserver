import { Field, ObjectType } from 'type-graphql';
import { User } from '../entities/user';

@ObjectType()
export class FollowInfo {
  @Field(() => [User])
  followers: User[];

  @Field(() => [User])
  followings: User[];
}
