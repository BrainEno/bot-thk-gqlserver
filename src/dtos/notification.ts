import { ObjectType, Field, ID } from 'type-graphql';

@ObjectType()
export class Notification {
  @Field(() => ID)
  id: string;

  @Field(() => String)
  message: string;

  @Field(() => String)
  linkString: string;

  @Field(() => String)
  dateString: string;
}
