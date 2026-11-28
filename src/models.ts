import { getModelForClass, ReturnModelType } from '@typegoose/typegoose';
import { Blog } from './entities/blog';
import { Category } from './entities/category';
import { Message } from './entities/message';
import { Tag } from './entities/tag';
import { User } from './entities/user';
import { Conversation } from './entities/conversation';
import { Participant } from './entities/participant';

export const BlogModel: ReturnModelType<typeof Blog> = getModelForClass(Blog, {
  schemaOptions: {
    collection: 'blogs',
    timestamps: true,
  },
});

export const UserModel: ReturnModelType<typeof User> = getModelForClass(User, {
  schemaOptions: {
    collection: 'users',
    timestamps: true,
  },
});

export const CategoryModel: ReturnModelType<typeof Category> = getModelForClass(Category, {
  schemaOptions: {
    collection: 'categories',
  },
});

export const TagModel: ReturnModelType<typeof Tag> = getModelForClass(Tag, {
  schemaOptions: {
    collection: 'tags',
  },
});

export const ConversationModel: ReturnModelType<typeof Conversation> = getModelForClass(Conversation, {
  schemaOptions: {
    collection: 'conversations',
    timestamps: true,
  },
});

export const MessageModel: ReturnModelType<typeof Message> = getModelForClass(Message, {
  schemaOptions: {
    collection: 'messages',
    timestamps: true,
  },
});

export const ParticipantModel: ReturnModelType<typeof Participant> = getModelForClass(Participant, {
  schemaOptions: {
    collection: 'participants',
  },
});
