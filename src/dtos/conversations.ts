import { Field, ObjectType } from 'type-graphql'

@ObjectType()
export class PopulatedUser {
    @Field(() => String)
    _id: string

    @Field(() => String)
    name: string

    @Field(() => String, { nullable: true })
    username?: string

    @Field(() => String)
    photo: string

    @Field(() => String)
    profile: string
}

@ObjectType()
class PopulatedParticipant {
    @Field(() => String)
    _id: string

    @Field(() => PopulatedUser)
    user: PopulatedUser

    @Field(() => Boolean)
    hasSeenLatestMessage: boolean

    @Field(() => String)
    userId: string
}

@ObjectType()
class PopulatedMessage {
    @Field(() => String)
    _id: string

    @Field(() => String)
    body: string

    @Field(() => PopulatedUser)
    sender: PopulatedUser

    @Field(() => String)
    senderId: string

    @Field(() => String)
    createdAt: string

    @Field(() => String)
    updatedAt?: string
}

@ObjectType()
export class PopulatedConversation {
    @Field(() => String)
    _id: string

    @Field(() => [PopulatedParticipant])
    participants: PopulatedParticipant[]

    @Field(() => [String])
    participantUserIds?: string[]

    @Field(() => [PopulatedMessage])
    messages: PopulatedMessage[]

    @Field(() => String)
    createdAt: string

    @Field(() => String, { nullable: true })
    updatedAt: string

    @Field(() => String, { nullable: true })
    latestMessageId?: string

    @Field(() => PopulatedMessage, { nullable: true })
    latestMessage?: PopulatedMessage
}

export interface ConversationUpdatedPayload {
    conversationUpdated: {
        conversation: PopulatedConversation
        addedUserIds?: string[]
        removedUserIds?: string[]
    }
}

@ObjectType()
export class ConversationUpdated {
    @Field(() => PopulatedConversation)
    conversation: PopulatedConversation

    @Field(() => [String], { nullable: true })
    addedUserIds?: string[]

    @Field(() => [String], { nullable: true })
    removedUserIds?: string[]
}
