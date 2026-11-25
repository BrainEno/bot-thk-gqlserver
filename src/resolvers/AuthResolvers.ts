import { ApolloError, AuthenticationError } from 'apollo-server-errors'
import { isEmail, isEmpty } from 'class-validator'
import dotenv from 'dotenv'
import jwt from 'jsonwebtoken'
import shortId from 'shortid'
import {
    Arg,
    Ctx,
    Mutation,
    Query,
    Resolver,
    UseMiddleware,
} from 'type-graphql'

import { TContext } from '../types'
import { UserModel } from '../models'
import sgMail from '@sendgrid/mail'
import {
    setRefreshToken,
    createRefreshToken,
    setAccessToken,
    createAccessToken,
} from '../utils/sendRefreshToken'
import { isAdmin } from '../middlewares/authChecker'
import { LoginResponse } from '../dtos/loginResponse'
import { User } from '../entities/user'
import { setPassword, verifyPassword } from '../services/passwordService'

dotenv.config()

export class EmailError extends ApolloError {
    constructor(message: string) {
        super(message, 'INVALID_EMAIL')
        Object.defineProperty(this, 'name', { value: 'email' })
    }
}

export class UsernameError extends ApolloError {
    constructor(message: string) {
        super(message, 'INVALID_USERNAME')
        Object.defineProperty(this, 'name', { value: 'username' })
    }
}

export class PasswordError extends ApolloError {
    constructor(message: string) {
        super(message, 'INVALID_PASSWORD')
        Object.defineProperty(this, 'name', { value: 'password' })
    }
}

@Resolver()
class AuthResolvers {
    @Mutation(() => String)
    async register(
        @Arg('name') name: string,
        @Arg('email') email: string,
        @Arg('password') password: string
    ): Promise<string> {
        const normalizedName = name.trim()
        const normalizedEmail = email.trim().toLowerCase()
        if (normalizedName.length < 1 || normalizedName.length > 32) {
            throw new UsernameError('用户名长度必须为 1 到 32 个字符')
        }
        if (!isEmail(normalizedEmail)) throw new EmailError('邮箱格式无效')
        if (password.length < 12 || password.length > 256) {
            throw new PasswordError('密码长度必须为 12 到 256 个字符')
        }

        const isUserExist = await UserModel.findOne({ name: normalizedName })
            .collation({ locale: 'en', strength: 2 })
            .exec()
        if (isUserExist) throw new UsernameError('该昵称已被占用，换一个试试')

        const isEmailExist = await UserModel.findOne({ email: normalizedEmail })
        if (isEmailExist) throw new EmailError('该邮箱已注册，请登录或找回密码')

        const username = shortId.generate()
        const profile = `${process.env.CLIENT_URL}/profile/${username}`
        const user = new UserModel({
            name: normalizedName,
            email: normalizedEmail,
            profile,
            username,
            role: '0',
            tokenVersion: 0,
        })
        await setPassword(user, password)
        await user.save()

        return createRefreshToken(user)
    }

    @Mutation(() => LoginResponse)
    async login(
        @Arg('email') email: string,
        @Arg('password') password: string,
        @Ctx() context: TContext
    ): Promise<LoginResponse> {
        const normalizedEmail = email.trim().toLowerCase()
        if (isEmpty(normalizedEmail) || isEmpty(password)) {
            throw new AuthenticationError('邮箱或密码错误')
        }

        const user = await UserModel.findOne({ email: normalizedEmail })
        const passwordMatches = user
            ? await verifyPassword(user, password)
            : false
        if (!user || !passwordMatches) {
            throw new AuthenticationError('邮箱或密码错误')
        }

        const { accessToken, accessTokenExpiry } = createAccessToken(user)
        const refreshToken = createRefreshToken(user)

        setRefreshToken(context.res, refreshToken)
        setAccessToken(context.res, accessToken)
        return {
            ok: true,
            accessToken,
            refreshToken,
            accessTokenExpiry,
        }
    }

    @Mutation(() => LoginResponse)
    async refreshToken(
        @Arg('refreshToken') refreshToken: string,
        @Ctx() { res }: TContext
    ): Promise<LoginResponse> {
        const invalidResponse: LoginResponse = {
            accessToken: '',
            accessTokenExpiry: -1,
            refreshToken: '',
            ok: false,
        }
        const secret = process.env.REFRESH_TOKEN_SECRET
        if (!secret) return invalidResponse

        try {
            const payload = jwt.verify(refreshToken, secret) as User
            const user = await UserModel.findOne({ _id: payload._id })
            if (!user || user.tokenVersion !== payload.tokenVersion) {
                return invalidResponse
            }

            const { accessToken, accessTokenExpiry } = createAccessToken(user)
            const newRefreshToken = createRefreshToken(user)
            setRefreshToken(res, newRefreshToken)
            setAccessToken(res, accessToken)

            return {
                accessToken,
                accessTokenExpiry,
                refreshToken: newRefreshToken,
                ok: true,
            }
        } catch {
            return invalidResponse
        }
    }

    @Query(() => User, { nullable: true })
    async currentUser(@Ctx() { user }: TContext): Promise<User | null> {
        if (!user) {
            return null
        }

        try {
            const curUser = await UserModel.findOne({
                _id: user._id,
                tokenVersion: user.tokenVersion,
            })

            if (curUser) {
                return curUser
            }
            return null
        } catch {
            throw new AuthenticationError('Unable to load the current user')
        }
    }

    @Mutation(() => Boolean)
    async logout(@Ctx() { req, res }: TContext): Promise<boolean> {
        if (req.headers.cookie) {
            req.headers.authorization = ''
            res.clearCookie('botthk')
            res.clearCookie('botthk_refresh')

            return true
        }
        return false
    }

    @Mutation(() => String)
    async forgotPassword(@Arg('email') email: string): Promise<string> {
        const response =
            '如果该邮箱已注册，重置指引将在几分钟内发送。请查看您的邮箱。'
        const normalizedEmail = email.trim().toLowerCase()
        if (!isEmail(normalizedEmail)) return response

        try {
            const user = await UserModel.findOne({ email: normalizedEmail })
            if (!user || !process.env.JWT_RESET_PASSWORD) return response

            const token = jwt.sign(
                { _id: user._id.toString(), tokenVersion: user.tokenVersion },
                process.env.JWT_RESET_PASSWORD,
                { expiresIn: '10m' }
            )
            const apiKey = process.env.SENDGRID_API_KEY
            if (!apiKey) return response

            sgMail.setApiKey(apiKey)
            await sgMail.send(genEmailData(normalizedEmail, token))
        } catch {
            // Do not reveal whether the account exists or expose reset credentials.
        }

        return response
    }

    @Mutation(() => Boolean)
    async resetPassword(
        @Ctx() { res }: TContext,
        @Arg('token') token: string,
        @Arg('password') password: string
    ): Promise<boolean> {
        if (password.length < 12 || password.length > 256) return false
        const secret = process.env.JWT_RESET_PASSWORD
        if (!secret) return false

        try {
            const payload = jwt.verify(token, secret) as {
                _id?: string
                tokenVersion?: number
            }
            if (!payload._id || typeof payload.tokenVersion !== 'number') {
                return false
            }

            const account = await UserModel.findOne({
                _id: payload._id,
                tokenVersion: payload.tokenVersion,
            }).exec()
            if (!account) return false

            await setPassword(account, password)
            account.tokenVersion += 1
            await account.save()
            res.clearCookie('botthk', { httpOnly: true, sameSite: 'none', secure: true })
            res.clearCookie('botthk_refresh', {
                httpOnly: true,
                sameSite: 'none',
                secure: true,
            })
            return true
        } catch {
            return false
        }
    }

    @UseMiddleware(isAdmin)
    @Mutation(() => Boolean)
    async revokeRefreshTokensForUser(
        @Arg('userId', () => String) userId: string
    ) {
        const user = await UserModel.findOne({ _id: userId })
        if (user) {
            user.tokenVersion += 1
            await user.save()
            return true
        }

        return false
    }
}

export default AuthResolvers

export const genEmailData = (email: string, token: string) => ({
    from: {
        name: 'BOT THK',
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
})
