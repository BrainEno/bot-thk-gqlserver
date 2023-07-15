import {
  Arg,
  Ctx,
  Mutation,
  Publisher,
  PubSub,
  Query,
  Resolver,
  ResolverFilterData,
  Root,
  Subscription,
} from 'type-graphql';

import { User } from '../entities/user';
import { TContext } from '../types';
import { Service } from 'typedi';
import { UserModel } from '../models';
import { AuthenticationError } from 'apollo-server-express';
import { isEmail, isEmpty } from 'class-validator';
import { Topic } from '../topic';
import { NewFollowerPayload } from '../interfaces/notification.interface';
import shortid from 'shortid';
import { Notification } from '../dtos/notification';
import { FollowInfo } from '../dtos/followInfo';
import { UserInfoResponse } from '../dtos/userInfoResponse';

@Service()
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
        username: user.username,
        name: user.name,
        email: user.email,
        about: user.about || '',
        photo: user.photo,
        createdAt: user.createdAt,
      };
    } catch (error) {
      console.log(error);
      throw error;
    }
  }

  @Query(() => [User], { nullable: true })
  async searchUsers(@Ctx() { user }: TContext, @Arg('name') name: string) {
    if (user === null) throw new AuthenticationError('please login');
    try {
      const users = await UserModel.find({
        name: { $regex: name, $options: 'i' },
      })
        .select(
          'username name email profile about photo followingIds followerIds'
        )
        .exec();

      if (!users) return [];
      return users;
    } catch (err) {
      throw err;
    }
  }

  @Query(() => FollowInfo, { nullable: true })
  async getFollowInfo(
    @Ctx() { user }: TContext,
    @Arg('username', { nullable: true }) username?: string
  ) {
    let toSearch: any;
    if (username) toSearch = await UserModel.findOne({ username });
    if (!username && user)
      toSearch = await UserModel.findOne({ _id: user._id });

    try {
      if (toSearch) {
        const followings = await UserModel.find({
          _id: {
            $in: toSearch.followings,
          },
        })
          .select(
            '_id username name email profile about photo followingIds followerIds'
          )
          .exec();

        const followers = await UserModel.find({
          _id: {
            $in: toSearch.followers,
          },
        })
          .select(
            '_id username name email profile about photo followingIds followerIds'
          )
          .exec();

        return { followers, followings };
      }
    } catch (err) {
      throw err;
    }
    return {
      followers: [],
      followings: [],
    };
  }

  @Mutation(() => Boolean)
  async follow(
    @Ctx() { user }: TContext,
    @Arg('followName') followName: string,
    @PubSub(Topic.NewNotification)
    notifyAboutNewFollower: Publisher<NewFollowerPayload>
  ) {
    if (isEmpty(followName)) throw new Error('该用户不存在');
    try {
      if (user === null) throw new AuthenticationError('not authenticated');
      const curUser = await UserModel.findOne({ _id: user._id });
      if (!curUser) throw new AuthenticationError('please login');

      const toFollow = await UserModel.findOne({ name: followName });

      if (!toFollow) throw new Error('该用户不存在或已注销');
      if (user._id === toFollow._id)
        throw new AuthenticationError('不能关注自己');

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

        await notifyAboutNewFollower(payload);

        await curUser.save();
        await toFollow.save();

        return true;
      } else {
        throw Error('already followed this user');
      }
    } catch (err) {
      console.log(err);
      return false;
    }
  }

  @Mutation(() => Boolean)
  async unFollow(@Ctx() context: TContext, @Arg('name') name: string) {
    if (isEmpty(name)) throw new Error('user not found');
    try {
      if (context.user === null)
        throw new AuthenticationError('not authenticated');
      const curUser = await UserModel.findOne({ _id: context.user._id });
      if (!curUser) throw new AuthenticationError('please login');

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
      console.log(err);
      return false;
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
      if (user === null) throw new AuthenticationError('please login');
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
      console.log(error);
      return false;
    }
  }

  @Subscription(() => Notification, {
    topics: Topic.NewNotification,
    filter: ({
      payload,
      args,
    }: ResolverFilterData<NewFollowerPayload, { name: string }>) => {
      return payload.followedName === args.name;
    },
  })
  userFollowed(
    @Root() payload: NewFollowerPayload,
    @Arg('name') name: string
  ): Notification {
    console.log('arg name: ', name);

    return {
      id: `user_${shortid.generate()}`,
      message: payload.followerName,
      dateString: payload.dateString ?? new Date().toISOString(),
      linkString: payload.followerUsername,
    };
  }
}

export default UserResolvers;
