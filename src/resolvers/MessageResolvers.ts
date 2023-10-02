import { AuthenticationError } from 'apollo-server-express';
import {
  Resolver,
  Query,
  Arg,
  Ctx,
  Mutation,
  PubSub,
  Publisher,
  Subscription,
  Root,
  Args,
} from 'type-graphql';
import { Message } from '../entities/message';
import { TContext } from '../types';
import { ConversationModel, MessageModel, ParticipantModel } from '../models';
import { GraphQLError } from 'graphql';
import { userIsConversationParticipant } from '../utils/userIsConversationParticipant';
import {
  SendMessageArgs,
  MessageSentPayload,
} from '../interfaces/message.interface';
import { Topic } from '../topic';
import { ConversationUpdatedPayload } from '../interfaces/conversation.interface';
import mongoose from 'mongoose';
import { Conversation } from '../entities/conversation';

@Resolver()
export default class MessageResolvers {
  @Query(() => [Message])
  async messages(
    @Arg('conversationId') conversationId: string,
    @Ctx() { user }: TContext
  ) {
    if (!user) {
      throw new AuthenticationError('Not authorized');
    }

    const conversation = await ConversationModel.findOne({
      _id: conversationId,
    })
      .populate('participants', 'userId')
      .exec();

    if (!conversation) {
      throw new GraphQLError('Conversation Not Found');
    }

    const participants = await ParticipantModel.find({
      _id: { $in: conversation.participants },
      conversationId,
    });

    const allowToView = userIsConversationParticipant(
      participants,
      user._id.toString()
    );

    if (!allowToView) {
      throw new Error('Access Denied');
    }

    try {
      const messages = await MessageModel.find({
        conversationId,
      })
        .populate('sender', '_id username name photo username')
        .sort({ createdAt: 'desc' })
        .exec();

      return messages;
    } catch (error) {
      console.log('messages error', error);
      throw new GraphQLError(error?.message);
    }
  }

  @Mutation(() => Boolean)
  async sendMessage(
    @Ctx() { user }: TContext,
    @Args() { conversationId, body, senderId }: SendMessageArgs,
    @PubSub(Topic.MessageSent)
    notifyMessageSent: Publisher<MessageSentPayload>,
    @PubSub(Topic.ConversationUpdated)
    notifyConversationUpdated: Publisher<ConversationUpdatedPayload>
  ) {
    if (!user) {
      throw new AuthenticationError('Not authorized');
    }

    // console.log(body);

    const { _id: userId } = user;

    const conversation = await ConversationModel.findOne({
      _id: conversationId,
    });

    if (!conversation) throw new GraphQLError('Conversation Not Found');

    try {
      const newMessage = await MessageModel.create({
        senderId,
        sender: new mongoose.Types.ObjectId(senderId),
        conversation: new mongoose.Types.ObjectId(conversationId),
        conversationId,
        body,
      });

      await newMessage.populate('sender', '_id username name');

      const participant = await ParticipantModel.findOne({
        userId,
        conversationId,
      });

      if (!participant) throw new GraphQLError('Participant does not exist');

      participant.hasSeenLatestMessage = true;
      await participant.save();

      const notMeParticipants = await ParticipantModel.find({
        userId: { $ne: userId },
        conversationId,
      });

      if (!notMeParticipants)
        throw new GraphQLError('Participant does not exist');

      notMeParticipants.forEach(async (np) => {
        np.hasSeenLatestMessage = false;
        await np.save();
      });

      const participants = [participant, ...notMeParticipants];

      const conversationInDB = await ConversationModel.findOne({
        _id: conversationId,
      });

      const messages = [newMessage._id, ...(conversationInDB?.messages || [])];

      if (!conversationInDB)
        throw new GraphQLError('Conversation does not exist');

      await conversationInDB.updateOne({
        latestMessage: newMessage._id,
        latestMessageId: newMessage._id.toString(),
        participants: participants.map((p) => p._id),
        messages,
      });

      const newConversation = await ConversationModel.findOne({
        _id: conversationId,
      }) as Conversation;

      notifyMessageSent({ messageSent: newMessage });
      notifyConversationUpdated({
        conversationUpdated: {
          conversation: newConversation,
        },
      });

      return true;
    } catch (error) {
      console.log('sendMessage error', error);
      throw new GraphQLError('Error sending message');
    }
  }

  @Subscription(() => Message, {
    topics: Topic.MessageSent,
    filter: ({ payload, args: { conversationId } }) => {
      return payload.messageSent.conversationId === conversationId;
    },
  })
  messageSent(@Root() payload: MessageSentPayload) {
    return payload.messageSent;
  }
}
