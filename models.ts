import { getModelForClass } from '@typegoose/typegoose'
import { Blog } from './src/entities/blog'
import { Category } from './src/entities/category'
import { Message } from './src/entities/message'
import { Tag } from './src/entities/tag'
import { User } from './src/entities/user'

export const BlogModel = getModelForClass(Blog, {
    schemaOptions: {
        collection: 'blogs',
        timestamps: true,
    },
})

export const UserModel = getModelForClass(User, {
    schemaOptions: {
        collection: 'users',
        timestamps: true,
    },
})

export const CategoryModel = getModelForClass(Category, {
    schemaOptions: {
        collection: 'categories',
    },
})

export const MessageModel = getModelForClass(Message, {
    schemaOptions: {
        collection: 'messages',
        timestamps: true,
    },
})

export const TagModel = getModelForClass(Tag, {
    schemaOptions: {
        collection: 'tags',
    },
})
