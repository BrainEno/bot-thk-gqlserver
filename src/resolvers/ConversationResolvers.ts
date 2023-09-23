import { AuthenticationError } from 'apollo-server-express';
import {
  Arg,
  Ctx,
  Query,
  Mutation,
  Resolver,
  Publisher,
  PubSub,
  Subscription,
  Root,
} from 'type-graphql';
import { TContext } from '../types';
import {
  ConversationModel,
  MessageModel,
  ParticipantModel,
  UserModel,
} from '../models';
import { GraphQLError } from 'graphql';
import { Topic } from '../topic';
import {
  ConversationCreatedPayload,
  ConversationUpdatedPayload,
  ConversationDeletedPayload,
} from '../interfaces/conversation.interface';
import { Conversation } from '../entities/conversation';
import dotenv from 'dotenv';
import mongoose, { Types } from 'mongoose';

dotenv.config();

@Resolver()
export default class ConversationResolvers {
  @Query(() => [Conversation])
  async conversations(@Ctx() { user }: TContext) {
    if (!user) {
      throw new AuthenticationError('Not authorized');
    }

    try {
      const conversations = await ConversationModel.find({
        participantUserIds: user._id.toString(),
      })
        .populate({
          path: 'participants',
          model: 'Participant',
          populate: [
            '_id userId',
            { path: 'user', model: 'User', populate: ['name _id photo'] },
          ],
        })
        .populate({
          path: 'latestMessage',
          model: 'Message',
          populate: [
            'body',
            {
              path: 'sender',
              model: 'User',
              populate: ['name _id photo'],
            },
          ],
        })
        .populate({
          path: 'messages',
          model: 'Message',
          populate: [
            'body createdAt',
            {
              path: 'sender',
              model: 'User',
              populate: ['_id name username photo'],
            },
          ],
        })
        .select('participants messages latestMessage createdAt')
        .exec();

      console.log('result res', conversations);

      return conversations;
    } catch (error) {
      console.log('error', error);
      throw new GraphQLError(error?.message);
    }
  }

  @Mutation(() => String)
  async createConversation(
    @Arg('participantUserIds', () => [String])
    participantUserIds: Array<string>,
    @Ctx() { user }: TContext,
    @PubSub(Topic.ConversationCreated)
    notifyAboutNewConversation: Publisher<ConversationCreatedPayload>
  ): Promise<string> {
    if (!user) {
      throw new AuthenticationError('Not authorized');
    }

    try {
      const participants = await Promise.all(
        participantUserIds.map(async (id) => {
          const user = await UserModel.findOne({ _id: id })
            .select('_id')
            .exec();

          if (!user) throw new GraphQLError('Error creating participant');

          return await ParticipantModel.create({
            user,
            userId: id,
            hasSeenLatestMessage: id === user._id.toString(),
          });
        })
      );

      if (!participants) throw new Error('Users not find');

      const conversation = await ConversationModel.create({
        participants: participants.map((p) => p._id),
        participantUserIds: participants.map((p) => p.userId),
      });

      await conversation.populate('participants', 'user userId');
      await conversation.populate('latestMessage', 'sender');

      await Promise.all(
        participants.map(async (p) => {
          p.conversation = conversation;
          p.conversationId = conversation._id.toString();
          p.userId = p.user._id.toString();
          await p.save();
        })
      );

      notifyAboutNewConversation({ conversationCreated: conversation });

      return conversation._id.toString();
    } catch (error) {
      console.log('createConversation error', error);
      throw new GraphQLError('Error creating conversation');
    }
  }

  @Mutation(() => Boolean)
  async markConversationAsRead(
    @Arg('userId') userId: string,
    @Arg('conversation') conversationId: string
  ): Promise<boolean> {
    try {
      await ParticipantModel.updateMany(
        {
          userId,
          conversationId,
        },
        {
          hasSeenLastestMessage: true,
        }
      );
      return true;
    } catch (error) {
      console.log('markConversationAsRead error', error);
      throw new GraphQLError(error.message);
    }
  }

  @Mutation(() => Boolean)
  async deleteConversation(
    @Arg('conversationId') conversationId: string,
    @Ctx() { user }: TContext,
    @PubSub(Topic.ConversationDeleted)
    notifyConversationDeleted: Publisher<ConversationDeletedPayload>
  ) {
    if (!user) {
      throw new AuthenticationError('Not authorized');
    }

    try {
      const toDelete = await ConversationModel.findOneAndRemove({
        _id: conversationId,
      });

      if (!toDelete) return false;

      const { deletedCount: mc } = await MessageModel.deleteMany({
        conversationId,
      });

      const { deletedCount: pc } = await ParticipantModel.deleteMany({
        conversationId,
      });

      console.log('deleted message count:', mc);
      console.log('deleted participant count:', pc);

      const deletedConversation = await toDelete.deleteOne();
      console.log('conversation deleted payload', deletedConversation);

      notifyConversationDeleted({ conversationDeleted: deletedConversation });
      return true;
    } catch (error) {
      console.log('deleteConversation error', error);
      throw new GraphQLError(error?.message);
    }
  }

  @Mutation(() => Boolean)
  async updateParticipants(
    @Ctx() { user }: TContext,
    @Arg('conversationId') conversationId: string,
    @Arg('participantIds', () => [String]) participantIds: Array<string>,
    @PubSub(Topic.ConversationUpdated)
    notifyConversationUpdated: Publisher<ConversationUpdatedPayload>
  ) {
    if (!user) {
      throw new AuthenticationError('Not authorized');
    }

    try {
      const participants = await ParticipantModel.find({ conversationId });

      const existingParticipants = participants.map((p) => p.userId.toString());

      console.log('existing ids:', existingParticipants);

      const participantsToDelete = existingParticipants.filter(
        (id) => !participantIds.includes(id)
      );

      // console.log('to delete participant:', participantsToDelete);

      const participantsToCreate = participantIds.filter(
        (id) => !existingParticipants.includes(id)
      );

      // console.log('to create participant:', participantsToCreate);

      const toUpdate = await ConversationModel.findOne({ _id: conversationId });

      if (!toUpdate) throw new GraphQLError('Conversation to update not found');

      let addUpdate: Conversation = toUpdate;
      let removeUpdate: Conversation = toUpdate;

      const db = await mongoose
        .createConnection(process.env.MONGODB_URI!)
        .asPromise();

      const session = await db.startSession();

      session.startTransaction();

      if (participantsToDelete.length) {
        await ParticipantModel.deleteMany({
          userId: { $in: participantsToDelete },
        });

        const participants = await ParticipantModel.find({
          userId: { $in: participantIds },
        });

        const conversation = await ConversationModel.findOneAndUpdate(
          { _id: conversationId },
          {
            participants: participants.map((p) => p._id),
            participantUserIds: participants.map((p) => p.userId),
          },
          { new: true }
        );

        removeUpdate = conversation as Conversation;
      }

      if (participantsToCreate.length) {
        await Promise.all(
          participantsToCreate.map(async (id) => {
            console.log('conversationId: ', conversationId);

            const participant = await ParticipantModel.create({
              user: new Types.ObjectId(id),
              userId: id,
              hasSeenLatestMessage: true,
              conversationId,
              conversation: new Types.ObjectId(conversationId),
            });

            console.log('new participant: ', participant);

            return participant;
          })
        );

        const participants = await ParticipantModel.find({ conversationId });

        await ConversationModel.updateOne(
          { _id: conversationId },
          {
            participants: participants.map((p) => p._id),
          }
        );

        const conversation = await ConversationModel.findOne({
          _id: conversationId,
        })
          .populate('participants', 'user userId')
          .populate('latestMessage', 'sender')
          .select('_id participants messages latestMessage createdAt')
          .exec();

        if (!conversation) return;

        await Promise.all(
          participants.map(async (p) => {
            await ParticipantModel.updateOne(
              { _id: p._id },
              {
                conversation: conversation._id,
                conversationId: conversation._id.toString(),
                userId: p.user._id.toString(),
              }
            );
          })
        );

        addUpdate = conversation as Conversation;
      }

      await session.commitTransaction();
      await session.endSession();

      const payload = {
        conversationUpdated: {
          conversation: addUpdate || removeUpdate,
          addedUserIds: participantsToCreate,
          removedUserIds: participantsToDelete,
        },
      };
      console.log('conversation update payload', payload);
      notifyConversationUpdated(payload);
      return true;
    } catch (error) {
      console.log('updateParticipants error', error);
      throw new GraphQLError(error?.message);
    }
  }

  @Subscription(() => Boolean, {
    topics: Topic.ConversationCreated,
  })
  conversationCreated(
    @Root() payload: ConversationCreatedPayload,
    @Ctx() { user }: TContext
  ) {
    if (!user) {
      throw new AuthenticationError('Not authorized');
    }

    const {
      conversationCreated: { participants },
    } = payload;

    //return if current user is conversation participant
    return !!participants.find((p) => p.toString() === user._id.toString());
  }

  @Subscription(() => Boolean, {
    topics: Topic.ConversationUpdated,
  })
  conversationUpdated(
    @Root() payload: ConversationUpdatedPayload,
    @Ctx() { user }: TContext
  ) {
    if (!user) {
      throw new AuthenticationError('Not authorized');
    }

    const {
      conversationUpdated: {
        conversation: { participants },
        removedUserIds,
      },
    } = payload;

    const userIsParticipant = !!participants.find(
      (p) => p.toString() === user._id.toString()
    );

    const latestMessage = MessageModel.findOne({
      _id: payload.conversationUpdated.conversation.latestMessage,
    });

    const userSentLastestMessage = latestMessage?.senderId === user._id;

    const userIsBeingRemoved =
      removedUserIds &&
      Boolean(removedUserIds.find((id) => id === user._id.toString()));

    return (
      (userIsParticipant && !userSentLastestMessage) ||
      userSentLastestMessage ||
      userIsBeingRemoved
    );
  }

  @Subscription(() => Boolean, {
    topics: Topic.ConversationDeleted,
  })
  conversationDeleted(
    @Root() payload: ConversationDeletedPayload,
    @Ctx() { user }: TContext
  ) {
    if (!user) {
      throw new AuthenticationError('Not authorized');
    }

    const {
      conversationDeleted: { participants },
    } = payload;

    return !!participants.find((p) => p.toString() === user._id.toString());
  }
}
