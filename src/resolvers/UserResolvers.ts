import { Arg, Ctx, Mutation, Query, Resolver } from 'type-graphql';

import { User } from '../entities/user';
import { TContext } from '../types';
import { Service } from 'typedi';
import { UserModel } from '../models';
import { AuthenticationError } from 'apollo-server-express';
import { isEmail, isEmpty } from 'class-validator';

@Service()
@Resolver()
class UserResolvers {
  @Query(() => String)
  hello(): string {
    return 'Hello from userResolver';
  }

  @Query(() => User, { nullable: true })
  async currentUser(@Ctx() { user }: TContext): Promise<User | null> {
    try {
      if (user === null) return null;
      return await UserModel.findById(user._id);
    } catch (error) {
      console.log(error);
      return null;
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
      const userInDB = await UserModel.findById(user._id);
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
      console.log(error)
      return false;
    }
  }
}

export default UserResolvers;
