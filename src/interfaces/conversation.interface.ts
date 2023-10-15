type UserPopulated = {
  _id: string;
  name: string;
  username: string;
  photo: string;
};

type ParticipantPopulated = {
  _id: string;
  user: UserPopulated;
  hasSeenLatestMessage: boolean;
  userId: string;
};

type MessagePopulated = {
  _id: string;
  body: string;
  sender: UserPopulated;
  senderId: string;
  createdAt: string;
  updatedAt?: string;
};

export type ConversationPopulated = {
  _id: string;
  participants: ParticipantPopulated[];
  participantUserIds?: string[];
  messages: MessagePopulated[];
  createdAt: string;
  updatedAt?: string;
  latestMessageId?: string;
  latestMessage?: MessagePopulated;
};

export interface ConversationUpdatedPayload {
  conversationUpdated: {
    conversation: ConversationPopulated;
    addedUserIds?: string[];
    removedUserIds?: string[];
  };
}

export interface ConversationCreatedPayload {
  conversationCreated: ConversationPopulated;
}

export interface ConversationDeletedPayload {
  conversationDeleted: ConversationPopulated;
}
