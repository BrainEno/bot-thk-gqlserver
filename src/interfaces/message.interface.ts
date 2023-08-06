import { MinLength } from 'class-validator';
import { ArgsType, Field } from 'type-graphql';
import { Message } from '../entities/message';

@ArgsType()
export class SendMessageArgs {
  @Field(() => String)
  conversationId: string;

  @Field(() => String)
  senderId: string;

  @Field(() => String, { nullable: false })
  @MinLength(1)
  body: string;
}

export interface MessageSentPayload {
  messageSent: Message;
}
