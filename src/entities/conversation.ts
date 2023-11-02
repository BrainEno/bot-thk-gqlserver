import {
  DocumentType,
  modelOptions,
  pre,
  prop,
  Ref,
  Severity,
} from "@typegoose/typegoose";
import { ObjectIdScalar as ObjectId } from "../utils/ObjectIdScalar";
import { ObjectId as ObjectID } from "mongoose";
import { Field, ObjectType } from "type-graphql";

import { Message } from "./message";
import { Participant } from "./participant";
import { ParticipantModel } from "../models";

@modelOptions({
  schemaOptions: {
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  },
  options: { allowMixed: Severity.ALLOW },
})
@ObjectType()
@pre<Conversation>("save", function () {
  this.latestMessageId = this.latestMessage?._id?.toString() || "";
})
export class Conversation {
  @Field(() => ObjectId)
  readonly _id: ObjectID;

  @prop({
    autopopulate: true,
    ref: "Participant",
    default: [] as Ref<Participant>[],
  })
  @Field(() => [Participant])
  participants: Ref<Participant>[];

  @prop(() => [String])
  @Field(() => [String])
  participantUserIds: string[];

  @prop({ autopopulate: true, ref: "Message", default: [] as Ref<Message>[] })
  @Field(() => [Message])
  messages: Ref<Message>[];

  @prop({ autopopulate: true, ref: () => Message })
  @Field(() => Message, { nullable: true })
  latestMessage?: Ref<Message>;

  @prop(() => String)
  @Field(() => String, { defaultValue: "" })
  latestMessageId: string;

  @Field(() => Date, { defaultValue: Date.now() })
  createdAt: Date;

  @Field(() => Date)
  updatedAt?: Date;

  public async getParticipantUserIds(this: DocumentType<Conversation>) {
    const participants = await ParticipantModel.find({
      conversationId: this._id.toString(),
    });
    return participants.map((p) => p.userId);
  }
}
