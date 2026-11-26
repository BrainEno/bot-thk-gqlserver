import { PubSub as GraphqlPubSub } from 'graphql-subscriptions'
import type { PubSub as TypeGraphqlPubSub } from 'type-graphql'
import { NewCommentPayload, ReplyCommentPayload } from './interfaces/comment.interface'
import {
    ConversationCreatedPayload,
    ConversationDeletedPayload,
    ConversationUpdatedPayload,
} from './interfaces/conversation.interface'
import { NewLikePayload } from './interfaces/like.interface'
import { MessageSentPayload } from './interfaces/message.interface'
import { NewBlogPayload, NewFollowerPayload } from './interfaces/notification.interface'

export enum Topic {
    NewComment = 'NEW_COMMENT',
    ReplyComment = 'REPlY_COMMENT',
    NewLike = 'NEW_LIKE',
    NewNotification = 'NEW_NOTIFICATION',
    ConversationCreated = 'CONVERSATION_CREATED',
    ConversationDeleted = 'CONVERSATION_DELETED',
    ConversationUpdated = 'CONVERSATION_UPDATED',
    MessageSent = 'MESSAGE_SENT',
}

export interface SubscriptionPayloads extends Record<string, unknown> {
    [Topic.NewComment]: NewCommentPayload
    [Topic.ReplyComment]: ReplyCommentPayload
    [Topic.NewLike]: NewLikePayload
    [Topic.NewNotification]: NewFollowerPayload | NewBlogPayload
    [Topic.ConversationCreated]: ConversationCreatedPayload
    [Topic.ConversationDeleted]: ConversationDeletedPayload
    [Topic.ConversationUpdated]: ConversationUpdatedPayload
    [Topic.MessageSent]: MessageSentPayload
}

export const eventBus = new GraphqlPubSub<SubscriptionPayloads>()

export const publishEvent = <K extends keyof SubscriptionPayloads & string>(
    topic: K,
    payload: SubscriptionPayloads[K]
): Promise<void> => eventBus.publish(topic, payload)

/** TypeGraphQL 2 expects a small async-iterable PubSub contract. */
export const typeGraphqlPubSub: TypeGraphqlPubSub = {
    publish: (topic, ...payload) => {
        void eventBus.publish(topic as keyof SubscriptionPayloads & string, payload[0] as never)
    },
    subscribe: (topic) => eventBus.asyncIterableIterator(topic),
}
