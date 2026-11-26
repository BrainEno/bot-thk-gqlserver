import { AuthenticationError } from '../errors/graphqlErrors';
import {
  Resolver,
  Query,
  Arg,
  Ctx,
  Mutation,
  Subscription,
  Root,
  Args,
} from "type-graphql";
import { Message } from "../entities/message";
import { TContext } from "../types";
import { ConversationModel, MessageModel, ParticipantModel } from "../models";
import { GraphQLError } from "graphql";
import {
  SendMessageArgs,
  MessageSentPayload,
} from "../interfaces/message.interface";
import { publishEvent, Topic } from "../topic";
import {
  ConversationPopulated,
} from "../interfaces/conversation.interface";
import mongoose from "mongoose";

@Resolver()
export default class MessageResolvers {
  @Query(() => [Message])
  async messages(
    @Arg("conversationId") conversationId: string,
    @Ctx() { user }: TContext
  ) {
    if (!user) {
      throw new AuthenticationError("Not authorized");
    }

    const conversation = await ConversationModel.findOne({
      _id: conversationId,
      participantUserIds: user._id.toString(),
    }).exec();

    if (!conversation) {
      throw new GraphQLError("Conversation Not Found");
    }

    try {
      const messages = await MessageModel.find({
        conversationId,
      })
        .populate(["_id body senderId createdAt"])
        .populate({
          path: "sender",
          model: "User",
          populate: ["_id name username photo"],
        })
        .select("_id createdAt senderId sender body")
        .sort({ createdAt: "desc" })
        .exec();

      return messages;
    } catch {
      throw new GraphQLError("Unable to load messages");
    }
  }

  @Mutation(() => Boolean)
  async sendMessage(
    @Ctx() { user }: TContext,
    @Args() { conversationId, body, senderId }: SendMessageArgs,
  ) {
    if (!user) {
      throw new AuthenticationError("Not authorized");
    }

    const userId = user._id.toString();
    if (senderId !== userId) {
      throw new AuthenticationError("Sender must match the authenticated user");
    }

    const conversation = await ConversationModel.findOne({
      _id: conversationId,
      participantUserIds: userId,
    });
    if (!conversation) throw new AuthenticationError("Not authorized");

    const participant = await ParticipantModel.findOne({
      userId,
      conversationId,
    });
    if (!participant) throw new AuthenticationError("Not authorized");

    try {
      const newMessage = await MessageModel.create({
        senderId: userId,
        sender: new mongoose.Types.ObjectId(userId),
        conversation: new mongoose.Types.ObjectId(conversationId),
        conversationId,
        body,
      });

      await newMessage.populate("sender", "_id username name photo");

      participant.hasSeenLatestMessage = true;
      await participant.save();

      const notMeParticipants = await ParticipantModel.find({
        userId: { $ne: userId },
        conversationId,
      });

      if (!notMeParticipants)
        throw new GraphQLError("Participant does not exist");

      await Promise.all(
        notMeParticipants.map(async (participant) => {
          participant.hasSeenLatestMessage = false;
          await participant.save();
        })
      );

      const participants = [participant, ...notMeParticipants];

      const conversationInDB = await ConversationModel.findOne({
        _id: conversationId,
      });

      const messages = [newMessage._id, ...(conversationInDB?.messages || [])];

      if (!conversationInDB)
        throw new GraphQLError("Conversation does not exist");

      await conversationInDB.updateOne({
        latestMessage: newMessage._id,
        latestMessageId: newMessage._id.toString(),
        participants: participants.map((p) => p._id),
        messages,
      });

      const newConversation = (await ConversationModel.findOne({
        _id: conversationId,
      })
        .populate({
          path: "participants",
          model: "Participant",
          populate: [
            "_id userId hasSeenLatestMessage",
            {
              path: "user",
              model: "User",
              populate: ["name _id photo"],
            },
          ],
        })
        .populate({
          path: "latestMessage",
          model: "Message",
          populate: [
            "body createdAt senderId",
            {
              path: "sender",
              model: "User",
              populate: ["username name _id photo"],
            },
          ],
        })
        .populate({
          path: "messages",
          model: "Message",
          populate: [
            "body createdAt senderId",
            {
              path: "sender",
              model: "User",
              populate: ["_id name username photo"],
            },
          ],
        })
        .select(
          "_id participantUserIds participants messages latestMessage latestMessageId createdAt updatedAt"
        )
        .exec()) as unknown as ConversationPopulated;

      await publishEvent(Topic.MessageSent, { messageSent: newMessage });
      await publishEvent(Topic.ConversationUpdated, {
        conversationUpdated: {
          conversation: newConversation,
        },
      });

      return true;
    } catch {
      throw new GraphQLError("Error sending message");
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
