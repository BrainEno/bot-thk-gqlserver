import { prop, Ref } from "@typegoose/typegoose";
import { ObjectIdScalar as ObjectId } from "../utils/ObjectIdScalar";
import { ObjectId as ObjectID } from "mongoose";
import { Field, ObjectType } from "type-graphql";

import { User } from "./user";
import { Conversation } from "./conversation";

@ObjectType()
export class Participant {
  @Field(() => ObjectId)
  readonly _id: ObjectID;

  @prop({ ref: "User" })
  @Field(() => User)
  user: Ref<User>;

  @prop(() => String)
  @Field(() => String)
  userId: string;

  @prop({ ref: "Conversation" })
  @Field(() => Conversation)
  conversation: Ref<Conversation>;

  @prop(() => String)
  @Field(() => String)
  conversationId: string;

  @prop(() => Boolean)
  @Field(() => Boolean)
  hasSeenLatestMessage: boolean;
}
