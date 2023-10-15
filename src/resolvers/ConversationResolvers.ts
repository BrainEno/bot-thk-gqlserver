import { AuthenticationError } from "apollo-server-express";
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
} from "type-graphql";
import { TContext } from "../types";
import {
  ConversationModel,
  MessageModel,
  ParticipantModel,
  UserModel,
} from "../models";
import { GraphQLError } from "graphql";
import { Topic } from "../topic";
import {
  ConversationCreatedPayload,
  ConversationUpdatedPayload,
  ConversationDeletedPayload,
  ConversationPopulated,
} from "../interfaces/conversation.interface";
import { Conversation } from "../entities/conversation";
import dotenv from "dotenv";
import mongoose, { Types } from "mongoose";
import {
  ConversationUpdated,
  PopulatedConversation,
  PopulatedUser,
} from "../dtos/conversations";

dotenv.config();

@Resolver()
export default class ConversationResolvers {
  @Query(() => [Conversation])
  async conversations(@Ctx() { user }: TContext) {
    if (!user) {
      throw new AuthenticationError("Not authorized");
    }

    console.log(user);

    try {
      const conversations = await ConversationModel.find({
        participantUserIds: user._id.toString(),
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
            "body _id senderId createdAt updatedAt",
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
            "body createdAt _id senderId updatedAt",
            {
              path: "sender",
              model: "User",
              populate: ["_id name username photo"],
            },
          ],
        })
        .select("participants messages latestMessage createdAt updatedAt")
        .exec();

      // console.log('result res', conversations);

      return conversations;
    } catch (error) {
      console.log("error", error);
      throw new GraphQLError(error?.message);
    }
  }

  @Mutation(() => String)
  async createConversation(
    @Arg("participantUserIds", () => [String])
    participantUserIds: Array<string>,
    @Ctx() { user }: TContext,
    @PubSub(Topic.ConversationCreated)
    notifyAboutNewConversation: Publisher<ConversationCreatedPayload>
  ): Promise<string> {
    if (!user) {
      throw new AuthenticationError("Not authorized");
    }

    try {
      const participants = await Promise.all(
        participantUserIds.map(async (id) => {
          const user = (await UserModel.findOne({ _id: id })
            .select("_id username name photo")
            .exec()) as unknown as PopulatedUser;

          if (!user) throw new GraphQLError("Error creating participant");

          return await ParticipantModel.create({
            user,
            userId: id,
            hasSeenLatestMessage: id === user._id.toString(),
          });
        })
      );

      if (!participants) throw new Error("Users not find");

      let conversation = await new ConversationModel({
        participants: participants.map((p) => p._id),
        participantUserIds: participants.map((p) => p.userId),
      }).save();

      await conversation.populate({
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
      });

      await conversation.populate({
        path: "latestMessage",
        model: "Message",
        populate: [
          "body",
          {
            path: "sender",
            model: "User",
            populate: ["username name _id photo"],
          },
        ],
      });

      await conversation.populate({
        path: "messages",
        model: "Message",
        populate: [
          "body createdAt",
          {
            path: "sender",
            model: "User",
            populate: ["_id name username photo"],
          },
        ],
      });

      conversation = conversation.toObject();

      // console.log(conversation);

      await Promise.all(
        participants.map(async (p) => {
          p.conversation = conversation;
          p.conversationId = conversation._id.toString();
          p.userId = p.user._id.toString();
          await p.save();
        })
      );

      const payload = { ...conversation, participants };
      console.log("conversation created payload: ", payload);
      notifyAboutNewConversation({
        conversationCreated: payload as unknown as ConversationPopulated,
      });

      return conversation._id.toString();
    } catch (error) {
      console.log("createConversation error", error);
      throw new GraphQLError("Error creating conversation");
    }
  }

  @Mutation(() => Boolean)
  async markConversationAsRead(
    @Arg("userId") userId: string,
    @Arg("conversationId") conversationId: string
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
      console.log("markConversationAsRead error", error);
      throw new GraphQLError(error.message);
    }
  }

  @Mutation(() => Boolean)
  async deleteConversation(
    @Arg("conversationId") conversationId: string,
    @Ctx() { user }: TContext,
    @PubSub(Topic.ConversationDeleted)
    notifyConversationDeleted: Publisher<ConversationDeletedPayload>
  ) {
    if (!user) {
      throw new AuthenticationError("Not authorized");
    }

    try {
      const toDelete = await ConversationModel.findOne({
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
            "body",
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
            "body createdAt",
            {
              path: "sender",
              model: "User",
              populate: ["_id name username photo"],
            },
          ],
        })
        .select(
          "_id participants participantUserIds messages latestMessage createdAt updatedAt"
        )
        .exec();

      if (!toDelete) return false;

      const { deletedCount: mc } = await MessageModel.deleteMany({
        conversationId,
      });

      const { deletedCount: pc } = await ParticipantModel.deleteMany({
        conversationId,
      });

      console.log("deleted message count:", mc);
      console.log("deleted participant count:", pc);

      const deletedConversation = await toDelete.deleteOne();
      console.log("conversation deleted payload", deletedConversation);

      const conversationDeleted = toDelete as unknown as PopulatedConversation;

      notifyConversationDeleted({
        conversationDeleted,
      });
      return true;
    } catch (error) {
      console.log("deleteConversation error", error);
      throw new GraphQLError(error?.message);
    }
  }

  @Mutation(() => Boolean)
  async updateParticipants(
    @Ctx() { user }: TContext,
    @Arg("conversationId") conversationId: string,
    @Arg("participantIds", () => [String]) participantIds: Array<string>,
    @PubSub(Topic.ConversationUpdated)
    notifyConversationUpdated: Publisher<ConversationUpdatedPayload>
  ) {
    if (!user) {
      throw new AuthenticationError("Not authorized");
    }

    try {
      const participants = await ParticipantModel.find({ conversationId });

      const existingParticipants = participants.map((p) => p.userId.toString());

      console.log("existing ids:", existingParticipants);

      const participantsToDelete = existingParticipants.filter(
        (id) => !participantIds.includes(id)
      );

      // console.log('to delete participant:', participantsToDelete);

      const participantsToCreate = participantIds.filter(
        (id) => !existingParticipants.includes(id)
      );

      // console.log('to create participant:', participantsToCreate);

      const toUpdate = (await ConversationModel.findOne({
        _id: conversationId,
      })) as ConversationPopulated;

      if (!toUpdate) throw new GraphQLError("Conversation to update not found");

      let addUpdate: ConversationPopulated = toUpdate;
      let removeUpdate: ConversationPopulated = toUpdate;

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
          conversationId,
        });

        const conversation = await ConversationModel.findOneAndUpdate(
          { _id: conversationId },
          {
            participants: participants.map((p) => p._id),
            participantUserIds: participants.map((p) => p.userId),
          },
          { new: true }
        )
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
              "body",
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
              "body createdAt",
              {
                path: "sender",
                model: "User",
                populate: ["_id name username photo"],
              },
            ],
          })
          .select(
            "_id participantUserIds participants messages latestMessage createdAt updatedAt"
          )
          .exec();

        removeUpdate = conversation as unknown as ConversationPopulated;
      }

      if (participantsToCreate.length) {
        await Promise.all(
          participantsToCreate.map(async (id) => {
            console.log("conversationId: ", conversationId);

            const participant = await ParticipantModel.create({
              user: new Types.ObjectId(id),
              userId: id,
              hasSeenLatestMessage: true,
              conversationId,
              conversation: new Types.ObjectId(conversationId),
            });

            console.log("new participant: ", participant);

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
              "body",
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
              "body createdAt",
              {
                path: "sender",
                model: "User",
                populate: ["_id name username photo"],
              },
            ],
          })
          .select(
            "_id participantUserIds participants messages latestMessage createdAt updatedAt"
          )
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

        addUpdate = conversation as unknown as ConversationPopulated;
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
      console.log("conversation update payload", payload);
      notifyConversationUpdated(payload);
      return true;
    } catch (error) {
      console.log("updateParticipants error", error);
      throw new GraphQLError(error?.message);
    }
  }

  @Subscription(() => PopulatedConversation, {
    topics: Topic.ConversationCreated,
    filter: ({
      payload,
      context,
    }: {
      payload: ConversationCreatedPayload;
      context: TContext;
    }) => {
      console.log("context in conversationcreated sub", context);
      if (!context.user) {
        throw new AuthenticationError("Not authorized");
      }

      const {
        conversationCreated: { participantUserIds },
      } = payload;

      //return if current user is conversation participant
      return !!participantUserIds?.find(
        (pId: string) => pId === context?.user?._id.toString()
      );
    },
  })
  conversationCreated(
    @Root() payload: ConversationCreatedPayload
  ): ConversationCreatedPayload["conversationCreated"] {
    return payload.conversationCreated;
  }

  @Subscription(() => ConversationUpdated, {
    topics: Topic.ConversationUpdated,
    filter: ({
      payload,
      context,
    }: {
      payload: ConversationUpdatedPayload;
      context: TContext;
    }) => {
      if (!context?.user) {
        throw new AuthenticationError("Not authorized");
      }

      console.log("updating payload in filter:", payload.conversationUpdated);
      console.log(
        "updating payload participants[0]:",
        payload.conversationUpdated.conversation.participants[0]
      );

      const {
        conversationUpdated: {
          conversation: { participantUserIds },
          removedUserIds,
        },
      } = payload;

      const userIsParticipant = !!participantUserIds?.find(
        (id: string) => id === context?.user?._id.toString()
      );

      const latestMessage = MessageModel.findOne({
        _id: payload.conversationUpdated.conversation.latestMessage,
      });

      const userSentLastestMessage =
        latestMessage?.senderId === context.user._id;

      const userIsBeingRemoved =
        removedUserIds &&
        Boolean(
          removedUserIds.find(
            (id: string) => id === context?.user?._id.toString()
          )
        );

      return Boolean(
        (userIsParticipant && !userSentLastestMessage) ||
          userSentLastestMessage ||
          userIsBeingRemoved
      );
    },
  })
  conversationUpdated(
    @Root() payload: ConversationUpdatedPayload
  ): ConversationUpdatedPayload["conversationUpdated"] {
    return payload.conversationUpdated;
  }

  @Subscription(() => PopulatedConversation, {
    topics: Topic.ConversationDeleted,
    filter: ({
      payload,
      context,
    }: {
      payload: ConversationDeletedPayload;
      context: TContext;
    }) => {
      if (!context?.user) {
        throw new AuthenticationError("Not authorized");
      }

      console.log("deleted payload in filter:", payload.conversationDeleted);
      const {
        conversationDeleted: { participants },
      } = payload;

      return !!participants.find(
        (p) => p.userId === context?.user?._id.toString()
      );
    },
  })
  conversationDeleted(
    @Root() { conversationDeleted }: ConversationDeletedPayload
  ): ConversationDeletedPayload["conversationDeleted"] {
    console.log("in del sub res:", conversationDeleted);
    return conversationDeleted;
  }
}
