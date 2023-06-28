import { prop, Ref } from '@typegoose/typegoose';
import { ObjectId } from 'bson';
import { ObjectId as ObjectID } from 'mongoose';
import { Field, ObjectType } from 'type-graphql';

import { User } from './user';
import { Message } from './message';

@ObjectType()
export class Conversation {
  @Field(() => ObjectId)
  readonly _id: ObjectID;

  @prop({ ref: 'User' })
  @Field(() => User)
  participants: Ref<User>[];

  @prop({ ref: 'Message' })
  @Field(() => Message)
  messages: Ref<Message>[];

  @prop({ ref: 'Message' })
  @Field(() => Message)
  latestMessage: Ref<Message>;

  @prop(() => String)
  @Field(() => String)
  latestMessageId: string;

  @Field(() => Date, { defaultValue: Date.now() })
  createdAt: Date;

  @Field(() => Date)
  updatedAt?: Date;
}
