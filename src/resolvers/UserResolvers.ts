import { logFailure } from '../services/LogService'
import { randomUUID } from 'node:crypto'
import {
  Arg,
  Ctx,
  Mutation,
  Query,
  Resolver,
  Root,
  Subscription,
} from 'type-graphql';

import { User } from '../entities/user';
import { TContext } from '../types';
import { UserModel } from '../models';
import { AuthenticationError } from '../errors/graphqlErrors';
import { isEmail, isEmpty } from 'class-validator';
import { publishEvent, Topic } from '../topic';
import { NewFollowerPayload } from '../interfaces/notification.interface';

import { Notification } from '../dtos/notification';
import { FollowInfo } from '../dtos/followInfo';
import { UserInfoResponse } from '../dtos/userInfoResponse';
import { toObjectId } from '../utils/toObjectId';

@Resolver()
class UserResolvers {
  @Query(() => UserInfoResponse)
  async getUserInfo(
    @Arg('username') username: string
  ): Promise<UserInfoResponse> {
    try {
      if (isEmpty(username)) throw new Error('invalid username');
      const user = await UserModel.findOne({ username });
      if (!user) throw new Error('user info not found');
      return {
        _id:user._id.toString(),
        username: user.username,
        name: user.name,
        about: user.about || '',
        photo: user.photo,
        createdAt: user.createdAt,
      };
    } catch (error) {
      logFailure('resolver.user.operation.failed', error)
      throw error;
    }
  }

  @Query(() => [UserInfoResponse])
  async searchUsers(@Arg('name') name: string): Promise<UserInfoResponse[]> {
    const searchTerm = name.trim().slice(0, 64)
    if (!searchTerm) return []

    const escapedTerm = [...searchTerm]
      .map((character) =>
        '.*+?^${}()|[]\\'.includes(character) ? `\\${character}` : character
      )
      .join('')
    const users = await UserModel.find({
      name: { $regex: escapedTerm, $options: 'i' },
    })
      .select('_id username name about photo createdAt')
      .limit(20)
      .exec()

    return users.map(toUserInfoResponse)
  }

  @Query(() => FollowInfo, { nullable: true })
  async getFollowInfo(
    @Ctx() { user }: TContext,
    @Arg('username', { nullable: true }) username?: string
  ) {
    let toSearch: User | null = null
    if (username) toSearch = await UserModel.findOne({ username })
    if (!username && user) {
      toSearch = await UserModel.findOne({ _id: user._id })
    }

    if (toSearch) {
      const followings = await UserModel.find({
        _id: { $in: (toSearch.followings ?? []).map((ref) => toObjectId(ref)) },
      })
        .select('_id username name about photo createdAt')
        .exec()

      const followers = await UserModel.find({
        _id: { $in: (toSearch.followers ?? []).map((ref) => toObjectId(ref)) },
      })
        .select('_id username name about photo createdAt')
        .exec()

      return {
        followers: followers.map(toUserInfoResponse),
        followings: followings.map(toUserInfoResponse),
      }
    }
    return {
      followers: [],
      followings: [],
    };
  }

  @Mutation(() => Boolean)
  async follow(
    @Ctx() { user }: TContext,
    @Arg('followName') followName: string
  ) {
    if (isEmpty(followName)) throw new Error('该用户不存在');
    try {
      if (user === null) throw new AuthenticationError('Not Authenticated');
      const curUser = await UserModel.findOne({ _id: user._id });
      if (!curUser) throw new AuthenticationError('Please Login');

      const toFollow = await UserModel.findOne({ name: followName });

      if (!toFollow) throw new Error('该用户不存在或已注销');
      if (user._id === toFollow._id)
        throw new Error('不能关注自己');

      if (!curUser.followings) curUser.followings = [];
      if (!toFollow.followers) toFollow.followers = [];

      if (
        !curUser.followings
          .map((u) => u._id.toString())
          .includes(toFollow._id.toString()) &&
        !toFollow.followers
          .map((u) => u._id.toString())
          .includes(curUser._id.toString())
      ) {
        curUser.followings.push(toFollow);
        toFollow.followers.push(curUser);

        await curUser.populate('followers');
        await curUser.populate('followings');
        await toFollow.populate('followers');
        await toFollow.populate('followings');

        curUser.addFollowingId(toFollow.id.toString());
        toFollow.addFollowerId(curUser.id.toString());

        const payload = {
          dateString: new Date().toISOString(),
          followerName: curUser.name,
          followedName: toFollow.name,
          followerUsername: curUser.username,
        };

        await publishEvent(Topic.NewNotification, payload);

        await curUser.save();
        await toFollow.save();

        return true;
      } else {
        throw Error('already followed this user');
      }
    } catch (err) {
      logFailure('resolver.user.operation.failed', err)
      throw err;
    }
  }

  @Mutation(() => Boolean)
  async unFollow(@Ctx() context: TContext, @Arg('name') name: string) {
    if (isEmpty(name)) throw new Error('user not found');
    try {
      if (context.user === null)
        throw new AuthenticationError('not authenticated');
      const curUser = await UserModel.findOne({ _id: context.user._id });
      if (!curUser) throw new AuthenticationError('Please Login');

      const unFollow = await UserModel.findOne({ name });

      if (!unFollow) throw new Error('该用户不存在或已注销');
      if (context.user._id === unFollow._id)
        throw new Error('illegal operation');

      if (!curUser.followings || !unFollow.followers) return;

      if (
        curUser.followings
          .map((f) => f._id.toString())
          .includes(unFollow._id.toString()) &&
        unFollow.followers
          .map((f) => f._id.toString())
          .includes(curUser._id.toString())
      ) {
        curUser.followings = curUser.followings.filter(
          (u) => u._id.toString() !== unFollow._id.toString()
        );
        unFollow.followers = unFollow.followers.filter(
          (u) => u._id.toString() !== curUser._id.toString()
        );

        await curUser.populate('followers');
        await curUser.populate('followings');
        await unFollow.populate('followers');
        await unFollow.populate('followings');

        curUser.removeFollowingId(unFollow.id.toString());
        unFollow.removeFollowerId(curUser.id.toString());

        await curUser.save();
        await unFollow.save();

        return true;
      } else {
        throw Error(`haven't followed this user yet`);
      }
    } catch (err) {
      logFailure('resolver.user.operation.failed', err)
      throw err;
    }
  }

  @Mutation(() => Boolean)
  async editProfile(
    @Ctx() { user }: TContext,
    @Arg('name', { nullable: true }) name?: string,
    @Arg('email', { nullable: true }) email?: string,
    @Arg('photo', { nullable: true }) photo?: string,
    @Arg('about', { nullable: true }) about?: string
  ): Promise<boolean> {
    try {
      if (user === null) throw new AuthenticationError('Please Login');
      const userInDB = await UserModel.findOne({ _id: user._id });
      if (userInDB) {
        if (!isEmpty(name)) {
          userInDB.name = name!;
        }
        if (!isEmpty(email) && isEmail(email)) {
          userInDB.email = email!;
        }

        if (!isEmpty(about)) {
          userInDB.about = about;
        }

        if (!isEmpty(photo)) {
          userInDB.photo = photo!;
        }
        await userInDB.save();
      }
      return true;
    } catch (error) {
      logFailure('resolver.user.operation.failed', error)
      return false;
    }
  }

  @Subscription(() => Notification, {
    topics: Topic.NewNotification,
    filter: ({
      payload,
      args,
    }) => {
      return payload.followedName === args.name;
    },
  })
  userFollowed(
    @Root() payload: NewFollowerPayload,
    @Arg('name') name: string
  ): Notification {
    // Keep the legacy subscription argument in the schema contract.
    void name

    return {
      id: `user_${randomUUID()}`,
      message: payload.followerName,
      dateString: payload.dateString ?? new Date().toISOString(),
      linkString: payload.followerUsername,
    };
  }
}

const toUserInfoResponse = (user: User): UserInfoResponse => ({
  _id: user._id.toString(),
  username: user.username,
  name: user.name,
  about: user.about || '',
  photo: user.photo,
  createdAt: user.createdAt,
})

export default UserResolvers;
