import { buildSchema } from '@typegoose/typegoose';
import { Conversation } from './entities/conversation';
import { Message } from './entities/message';
import { Participant } from './entities/participant';

export const ParticipantSchema = buildSchema(Participant);
export const MessageSchema = buildSchema(Message);
export const ConversationSchema = buildSchema(Conversation);
