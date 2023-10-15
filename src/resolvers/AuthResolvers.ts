import { ApolloError, AuthenticationError } from "apollo-server-errors";
import { isEmail, isEmpty } from "class-validator";
import dotenv from "dotenv";
import jwt from "jsonwebtoken";
import path from "path";
import shortId from "shortid";
import {
  Arg,
  Ctx,
  Mutation,
  Query,
  Resolver,
  UseMiddleware,
} from "type-graphql";

import { TContext } from "../types";
import { UserModel } from "../models";
import sgMail from "@sendgrid/mail";
import {
  setRefreshToken,
  createRefreshToken,
  setAccessToken,
  createAccessToken,
} from "../utils/sendRefreshToken";
import { isAdmin } from "../middlewares/authChecker";
import { LoginResponse } from "../dtos/LoginResponse";
import { User } from "../entities/user";

dotenv.config({ path: path.join(__dirname, "../.env.local") });

export class EmailError extends ApolloError {
  constructor(message: string) {
    super(message, "INVALID_EMAIL");
    Object.defineProperty(this, "name", { value: "email" });
  }
}

export class UsernameError extends ApolloError {
  constructor(message: string) {
    super(message, "INVALID_USERNAME");
    Object.defineProperty(this, "name", { value: "username" });
  }
}

export class PasswordError extends ApolloError {
  constructor(message: string) {
    super(message, "INVALID_PASSWORD");
    Object.defineProperty(this, "name", { value: "password" });
  }
}

@Resolver()
class AuthResolvers {
  @Mutation(() => String)
  async register(
    @Arg("name") name: string,
    @Arg("email") email: string,
    @Arg("password") password: string
  ): Promise<string> {
    try {
      const isUserExist = await UserModel.findOne({
        name: name.toLowerCase(),
      });
      if (isUserExist) throw new UsernameError("该昵称已被占用，换一个试试");

      const isEmailExist = await UserModel.findOne({
        email: email.toLowerCase(),
      });
      if (isEmailExist) throw new EmailError("该邮箱已注册，请登录或找回密码");
      const username = shortId.generate();
      const profile = `${process.env.CLIENT_URL}/profile/${username}`;
      const user = new UserModel({
        name,
        email,
        password,
        profile,
        username,
        role: "0",
        tokenVersion: 0,
      });

      const token = createRefreshToken(user);

      await user.save();
      return token;
    } catch (err: unknown) {
      throw err;
    }
  }

  @Mutation(() => LoginResponse)
  async login(
    @Arg("email") email: string,
    @Arg("password") password: string,
    @Ctx() context: TContext
  ): Promise<LoginResponse> {
    try {
      if (isEmpty(email)) throw new EmailError("邮箱不得为空");
      if (isEmpty(password)) throw new PasswordError("密码不得为空");
      const user = await UserModel.findOne({ email });
      if (!user) throw new EmailError("未找到邮箱，请先注册");

      const passwordMatches = user.authenticate(password);
      if (!passwordMatches)
        throw new PasswordError("邮箱和密码不匹配，请重新输入");

      const { accessToken, accessTokenExpiry } = createAccessToken(user);
      const refreshToken = createRefreshToken(user);

      setRefreshToken(context.res, refreshToken);
      setAccessToken(context.res, accessToken);
      console.log("login accessToken:", accessToken);
      return {
        ok: true,
        accessToken,
        refreshToken,
        accessTokenExpiry,
      };
    } catch (error) {
      console.log(error);
      throw new AuthenticationError(error);
    }
  }

  @Mutation(() => LoginResponse)
  async refreshToken(@Arg("refreshToken") refreshToken: string) {
    const payload = jwt.verify(
      refreshToken,
      process.env.REFRESH_TOKEN_SECRET as string
    ) as User;

    if (payload) {
      const user = await UserModel.findOne({ _id: payload._id });
      //check if token version is valid
      if (user && user?.tokenVersion === payload.tokenVersion) {
        const { accessToken, accessTokenExpiry } = createAccessToken(user);

        const newRefreshToken = createRefreshToken(user);

        console.log("refresh token accessToken:", accessToken);

        return {
          accessToken,
          accessTokenExpiry,
          refreshToken: newRefreshToken,
          ok: true,
        };
      }
    }

    return {
      accessToken: "",
      accessTokenExpiry: -1,
      refreshToken: "",
      ok: false,
    };
  }

  @Query(() => User, { nullable: true })
  async currentUser(@Ctx() { user }: TContext): Promise<User | null> {
    if (!user) {
      return null;
    }

    try {
      const curUser = await UserModel.findOne({
        _id: user._id,
        tokenVersion: user.tokenVersion,
      });

      if (curUser) {
        return curUser;
      }
      return null;
    } catch (error) {
      console.log(error);
      throw new AuthenticationError(error);
    }
  }

  @Mutation(() => Boolean)
  async logout(@Ctx() { req, res }: TContext): Promise<boolean> {
    if (req.headers.cookie) {
      req.headers.authorization = "";
      res.clearCookie("botthk");
      res.clearCookie("botthk_refresh");

      return true;
    }
    return false;
  }

  @Mutation(() => String)
  async forgotPassword(@Arg("email") email: string) {
    const user = await UserModel.findOne({ email });
    if (!user) throw new Error("User not found");

    const token = jwt.sign({ _id: user._id }, process.env.JWT_RESET_PASSWORD!, {
      expiresIn: "10m",
    });
    try {
      const emailData = genEmailData(email, token);
      await sgMail.send(emailData);
      return `邮件已发送给${email}。请跟随指引重置您的密码，链接10分钟内有效。`;
    } catch (error) {
      if (user && isEmail(email)) {
        return `${process.env.CLIENT_URL}/auth/password/reset/${token}`;
      }
      return error;
    }
  }

  @Mutation(() => Boolean)
  async resetPassword(
    @Ctx() { user }: TContext,
    @Arg("username") username: string,
    @Arg("password") password: string
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

  @UseMiddleware(isAdmin)
  @Mutation(() => Boolean)
  async revokeRefreshTokensForUser(
    @Arg("userId", () => String) userId: string
  ) {
    const user = await UserModel.findOne({ _id: userId });
    if (user) {
      user.tokenVersion += 1;
      await user.save();
      return true;
    }

    return false;
  }
}

export default AuthResolvers;

export const genEmailData = (email: string, token: string) => ({
  from: {
    name: "BOT THK",
    email: process.env.EMAIL_FROM as string,
  },
  to: email,
  subject: `重置密码`,
  html: `
<body>
<div 
  style="
  padding:25px;
  background:#F7F7F7;
">
    <h3 
    style="background:black;
    color:white;
    margin:15px auto;
    width:max-content;
    align-text:center;
    padding:15px;">
    BOT THK
    </h3>
    <h4 style="text-align:center;">忘记了密码？ 请点击下方链接重新设置密码</h4>
    <br/>
    <a 
    style="width:600px;
    text-decoration:underline;
    color:#0061D5;
    text-align:center;"
    href="${process.env.CLIENT_URL}/auth/password/reset/${token}"
    >   ${process.env.CLIENT_URL}/auth/password/reset/${token}
    </a>
    <br/>
    <p style="text-align:center">—— 邮件发送自BTN THK ，独立创作平台 ——</p>
    <p style='font-size:18px;text-decoration:underline;
text-align:center;'>https://bot-thk.vercel.app</p>
</div>
<body>
      `,
});
