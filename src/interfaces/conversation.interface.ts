import { Conversation } from '../entities/conversation';

export interface ConversationCreatedPayload {
  conversationCreated: Conversation;
}

export interface ConversationDeletedPayload {
  conversationDeleted: Conversation;
}

export interface ConversationUpdatedPayload {
  conversationUpdated: {
    conversation: Conversation;
    addedUserIds?: string[];
    removedUserIds?: string[];
  };
}
