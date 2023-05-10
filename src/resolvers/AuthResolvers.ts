import { ApolloError } from 'apollo-server-errors';
import { isEmpty } from 'class-validator';
import dotenv from 'dotenv';
import jwt from 'jsonwebtoken';
import path from 'path';
import shortId from 'shortid';
import { Arg, Ctx, Mutation, Resolver } from 'type-graphql';

import { TContext } from '../types';
import { Service } from 'typedi';
import { LoginRes } from '../dtos/LoginRes';
import { UserModel } from '../models';

dotenv.config({ path: path.join(__dirname, '../.env.local') });

export class EmailError extends ApolloError {
  constructor(message: string) {
    super(message, 'INVALID_EMAIL');
    Object.defineProperty(this, 'name', { value: 'email' });
  }
}

export class UsernameError extends ApolloError {
  constructor(message: string) {
    super(message, 'INVALID_USERNAME');
    Object.defineProperty(this, 'name', { value: 'username' });
  }
}

export class PasswordError extends ApolloError {
  constructor(message: string) {
    super(message, 'INVALID_PASSWORD');
    Object.defineProperty(this, 'name', { value: 'password' });
  }
}

@Service()
@Resolver()
class AuthResolvers {
  @Mutation(() => String)
  async register(
    @Arg('name') name: string,
    @Arg('email') email: string,
    @Arg('password') password: string
  ): Promise<string> {
    try {
      const isUserExist = await UserModel.findOne({
        name: name.toLowerCase(),
      });
      if (isUserExist) throw new UsernameError('该昵称已被占用，换一个试试');

      const isEmailExist = await UserModel.findOne({
        email: email.toLowerCase(),
      });
      if (isEmailExist) throw new EmailError('该邮箱已注册，请登录或找回密码');
      const username = shortId.generate();
      const profile = `${process.env.CLIENT_URL}/profile/${username}`;
      const user = new UserModel({
        name,
        email,
        password,
        profile,
        username,
        role: '0',
      });

      const token = jwt.sign(
        { _id: user._id, role: user.role },
        process.env.JWT_SECRET!,
        { expiresIn: '7d' }
      ) as string;

      await user.save();
      return token;
    } catch (err: unknown) {
      throw err;
    }
  }

  @Mutation(() => LoginRes)
  async login(
    @Arg('email') email: string,
    @Arg('password') password: string,
    @Ctx() context: TContext
  ): Promise<LoginRes> {
    try {
      if (isEmpty(email)) throw new EmailError('邮箱不得为空');
      if (isEmpty(password)) throw new PasswordError('密码不得为空');
      const user = await UserModel.findOne({ email });
      if (!user) throw new EmailError('未找到邮箱，请先注册');

      const passwordMatches = user.authenticate(password);
      if (!passwordMatches)
        throw new PasswordError('邮箱和密码不匹配，请重新输入');

      const token = jwt.sign(
        { _id: user._id, role: user.role },
        process.env.JWT_SECRET!,
        { expiresIn: '7d' }
      );

      context.res.cookie('token', token, {
        httpOnly: true,
        maxAge: 1000 * 60 * 60 * 24 * 7,
      });

      return { accessToken: token };
    } catch (error) {
      console.log(error);
      return { accessToken: '' };
    }
  }

  @Mutation(() => Boolean)
  async resetPassword(
    @Ctx() { user }: TContext,
    @Arg('username') username: string,
    @Arg('password') password: string
  ) {
    try {
      const authedUser = await UserModel.findOne({
        _id: user?._id,
        username: username,
      }).exec();
      if (!!authedUser) {
        if (!isEmpty(password)) {
          await authedUser.updatePassword(password);

          return true;
        }
      }
      return false;
    } catch (error) {
      console.error(error);

      return false;
    }
  }
}

export default AuthResolvers;
