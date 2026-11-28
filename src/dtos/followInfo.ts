import { Field, ObjectType } from 'type-graphql';
import { UserInfoResponse } from './userInfoResponse';

@ObjectType()
export class FollowInfo {
  @Field(() => [UserInfoResponse])
  followers: UserInfoResponse[];

  @Field(() => [UserInfoResponse])
  followings: UserInfoResponse[];
}
