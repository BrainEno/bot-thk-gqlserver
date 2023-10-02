import { Field, ObjectType } from 'type-graphql';
import { Conversation } from '../entities/conversation';
@ObjectType()
export class ConversationUpdated {
  @Field(() => Conversation)
  conversation: Conversation;

  @Field(() => [String], { nullable: true })
  addedUserIds?: string[];

  @Field(() => [String], { nullable: true })
  removedUserIds?: string[];
}
