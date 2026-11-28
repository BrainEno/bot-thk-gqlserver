import { normalizeUserId } from './userIdentity'

export type SubscriptionContext = {
    user?: { _id?: unknown } | null
} | null | undefined

export const subscriptionUserId = (context: SubscriptionContext): string | null =>
    normalizeUserId(context?.user?._id)

export const isRecipient = (
    recipientUserIds: readonly string[] | null | undefined,
    context: SubscriptionContext
): boolean => {
    const userId = subscriptionUserId(context)
    return Boolean(userId && recipientUserIds?.includes(userId))
}

export const isConversationParticipant = (
    participantUserIds: readonly string[] | null | undefined,
    context: SubscriptionContext
): boolean => isRecipient(participantUserIds, context)

export const canReceiveMessage = (
    messageConversationId: string | null | undefined,
    requestedConversationId: string,
    participantUserIds: readonly string[] | null | undefined,
    context: SubscriptionContext
): boolean =>
    messageConversationId === requestedConversationId &&
    isConversationParticipant(participantUserIds, context)

export const isRemovedConversationParticipant = (
    removedUserIds: readonly string[] | null | undefined,
    context: SubscriptionContext
): boolean => isRecipient(removedUserIds, context)
