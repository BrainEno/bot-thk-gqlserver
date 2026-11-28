import { AuthenticationError } from '../errors/graphqlErrors';
import { logFailure } from '../services/LogService';
import {
  Arg,
  Authorized,
  Ctx,
  Query,
  Mutation,
  Resolver,
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
import {
  isConversationParticipant,
  isRecipient,
  isRemovedConversationParticipant,
} from "../services/subscriptionAccess";
import { publishEvent, Topic } from "../topic";
import {
  ConversationCreatedPayload,
  ConversationUpdatedPayload,
  ConversationDeletedPayload,
  ConversationPopulated,
} from "../interfaces/conversation.interface";
import { Conversation } from "../entities/conversation";
import { Types } from "mongoose";
import {
  ConversationUpdated,
  PopulatedConversation,
  PopulatedUser,
} from "../dtos/conversations";

@Resolver()
export default class ConversationResolvers {
  @Query(() => [Conversation])
  async conversations(@Ctx() { user }: TContext) {
    if (!user) {
      throw new AuthenticationError("Not authorized");
    }


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


      return conversations;
    } catch (error) {
      logFailure('conversation.list.failed', error)
      throw new GraphQLError("Unable to load conversations");
    }
  }

  @Mutation(() => String)
  async createConversation(
    @Arg("participantUserIds", () => [String])
    participantUserIds: Array<string>,
    @Ctx() { user }: TContext,
  ): Promise<string> {
    if (!user) {
      throw new AuthenticationError("Not authorized");
    }

    try {
      const memberIds = Array.from(
        new Set([...participantUserIds, user._id.toString()])
      )
      const participants = await Promise.all(
        memberIds.map(async (id) => {
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

      const conversation = await new ConversationModel({
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

      const conversationData = conversation.toObject();


      await Promise.all(
        participants.map(async (p) => {
          p.conversation = conversation;
          p.conversationId = conversation._id.toString();
          p.userId = p.user._id.toString();
          await p.save();
        })
      );

      const payload = { ...conversationData, participants };
      await publishEvent(Topic.ConversationCreated, {
        conversationCreated: payload as unknown as ConversationPopulated,
      });

      return conversation._id.toString();
    } catch (error) {
      logFailure('conversation.create.failed', error)
      throw new GraphQLError("Error creating conversation");
    }
  }

  @Mutation(() => Boolean)
  async markConversationAsRead(
    @Arg("userId") userId: string,
    @Arg("conversationId") conversationId: string,
    @Ctx() { user }: TContext
  ): Promise<boolean> {
    if (!user || user._id.toString() !== userId) {
      throw new AuthenticationError("Not authorized");
    }

    const result = await ParticipantModel.updateOne(
      { userId: user._id.toString(), conversationId },
      { $set: { hasSeenLatestMessage: true } }
    )
    return result.matchedCount === 1
  }

  @Mutation(() => Boolean)
  async deleteConversation(
    @Arg("conversationId") conversationId: string,
    @Ctx() { user }: TContext,
  ) {
    if (!user) {
      throw new AuthenticationError("Not authorized");
    }

    try {
      const toDelete = await ConversationModel.findOne({
        _id: conversationId,
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

      await MessageModel.deleteMany({ conversationId });
      await ParticipantModel.deleteMany({ conversationId });

      await toDelete.deleteOne();

      const conversationDeleted = toDelete as unknown as PopulatedConversation;

      await publishEvent(Topic.ConversationDeleted, {
        conversationDeleted,
      });
      return true;
    } catch (error) {
      logFailure('conversation.delete.failed', error)
      throw new GraphQLError("Unable to delete conversation");
    }
  }

  @Mutation(() => Boolean)
  async updateParticipants(
    @Ctx() { user }: TContext,
    @Arg("conversationId") conversationId: string,
    @Arg("participantIds", () => [String]) participantIds: Array<string>,
  ) {
    if (!user) {
      throw new AuthenticationError("Not authorized");
    }

    try {
      const participants = await ParticipantModel.find({ conversationId });

      const existingParticipants = participants.map((p) => p.userId.toString());


      const participantsToDelete = existingParticipants.filter(
        (id) => !participantIds.includes(id)
      );


      const participantsToCreate = participantIds.filter(
        (id) => !existingParticipants.includes(id)
      );


      const toUpdate = (await ConversationModel.findOne({
        _id: conversationId,
        participantUserIds: user._id.toString(),
      })) as ConversationPopulated | null;

      if (!toUpdate) throw new GraphQLError("Conversation to update not found");

      let addUpdate: ConversationPopulated = toUpdate;
      let removeUpdate: ConversationPopulated = toUpdate;

      if (participantsToDelete.length) {
        await ParticipantModel.deleteMany({
          conversationId,
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
            const participant = await ParticipantModel.create({
              user: new Types.ObjectId(id),
              userId: id,
              hasSeenLatestMessage: true,
              conversationId,
              conversation: new Types.ObjectId(conversationId),
            });

            return participant;
          })
        );

        const participants = await ParticipantModel.find({ conversationId });

        await ConversationModel.updateOne(
          { _id: conversationId },
          {
            participants: participants.map((p) => p._id),
            participantUserIds: participants.map((p) => p.userId.toString()),
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

      const conversationForUpdate = participantsToCreate.length
        ? addUpdate
        : participantsToDelete.length
          ? removeUpdate
          : toUpdate
      const recipientUserIds = [
        ...new Set((conversationForUpdate.participantUserIds ?? []).map(String)),
      ]
      const payload = {
        conversationUpdated: {
          conversation: conversationForUpdate,
          addedUserIds: participantsToCreate,
          removedUserIds: participantsToDelete,
        },
        recipientUserIds,
      };
      await publishEvent(Topic.ConversationUpdated, payload);
      return true;
    } catch (error) {
      logFailure('conversation.participants.update.failed', error)
      throw new GraphQLError("Unable to update conversation participants");
    }
  }

  @Authorized()
  @Subscription(() => PopulatedConversation, {
    topics: Topic.ConversationCreated,
    filter: ({ payload, context }: {
      payload: ConversationCreatedPayload;
      context: TContext;
    }) => isConversationParticipant(
      payload.conversationCreated.participantUserIds,
      context
    ),
  })
  conversationCreated(
    @Root() payload: ConversationCreatedPayload
  ): ConversationCreatedPayload["conversationCreated"] {
    return payload.conversationCreated;
  }

  @Authorized()
  @Subscription(() => ConversationUpdated, {
    topics: Topic.ConversationUpdated,
    filter: ({ payload, context }: {
      payload: ConversationUpdatedPayload;
      context: TContext;
    }) => isRecipient(payload.recipientUserIds, context),
  })
  conversationUpdated(
    @Root() payload: ConversationUpdatedPayload
  ): ConversationUpdatedPayload["conversationUpdated"] {
    return payload.conversationUpdated;
  }

  @Authorized()
  @Subscription(() => String, {
    topics: Topic.ConversationUpdated,
    filter: ({ payload, context }: {
      payload: ConversationUpdatedPayload;
      context: TContext;
    }) => isRemovedConversationParticipant(
      payload.conversationUpdated.removedUserIds,
      context
    ),
  })
  conversationRemoved(@Root() payload: ConversationUpdatedPayload): string {
    return payload.conversationUpdated.conversation._id.toString()
  }

  @Authorized()
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
    return conversationDeleted;
  }
}
