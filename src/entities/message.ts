import { prop, Ref } from "@typegoose/typegoose";
import { Max, Min } from "class-validator";
import { ObjectId } from "bson";
import { ObjectId as ObjectID } from "mongoose";
import { Field, ObjectType } from "type-graphql";

import { User } from "./user";
import { Conversation } from "./conversation";

@ObjectType()
export class Message {
  @Field(() => ObjectId)
  readonly _id: ObjectID;

  @prop({ type: () => String, trim: true, required: true, maxlength: 500 })
  @Field()
  @Min(1)
  @Max(500)
  msgContent: string;

  @prop({ref:'Conversation'})
  conversation:Ref<Conversation>

  @prop(()=>String)
  conversationId:string;

  @prop(()=>Boolean)
  isLatestIn:boolean;

  @prop({ ref: "User" })
  @Field(() => User)
  sender: Ref<User>;

  @prop({ ref: "User" })
  @Field(() => User)
  reciver: Ref<User>;

  @Field(() => Date)
  createdAt: Date;

  @Field(() => Date)
  updatedAt?: Date;
}
