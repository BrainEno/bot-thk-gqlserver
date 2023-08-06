import { getModelForClass } from '@typegoose/typegoose';
import { Blog } from './entities/blog';
import { Category } from './entities/category';
import { Message } from './entities/message';
import { Tag } from './entities/tag';
import { User } from './entities/user';
import { Conversation } from './entities/conversation';
import { Participant } from './entities/participant';

export const BlogModel = getModelForClass(Blog, {
  schemaOptions: {
    collection: 'blogs',
    timestamps: true,
  },
});

export const UserModel = getModelForClass(User, {
  schemaOptions: {
    collection: 'users',
    timestamps: true,
  },
});

export const CategoryModel = getModelForClass(Category, {
  schemaOptions: {
    collection: 'categories',
  },
});

export const TagModel = getModelForClass(Tag, {
  schemaOptions: {
    collection: 'tags',
  },
});

export const ConversationModel = getModelForClass(Conversation, {
  schemaOptions: {
    collection: 'conversations',
    timestamps: true,
  },
});

export const MessageModel = getModelForClass(Message, {
  schemaOptions: {
    collection: 'messages',
    timestamps: true,
  },
});

export const ParticipantModel = getModelForClass(Participant, {
  schemaOptions: {
    collection: 'participants',
  },
});
