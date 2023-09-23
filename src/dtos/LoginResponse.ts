import { Field, ObjectType } from 'type-graphql';

@ObjectType()
export class LoginResponse {
  @Field()
  ok: boolean;

  @Field()
  accessToken: string;

  @Field()
  refreshToken:string;

  @Field()
  accessTokenExpiry:number;
}
