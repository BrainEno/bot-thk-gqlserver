import { AuthenticationError } from 'apollo-server-errors'
import { isEmpty } from 'class-validator'
import dotenv from 'dotenv'
import jwt from 'jsonwebtoken'
import path from 'path'
import shortId from 'shortid'
import { Arg, Ctx, Mutation, Resolver } from 'type-graphql'

import { TContext } from '../types'
import { Service } from 'typedi'
import { LoginResponse } from '../dtos/LoginResponse'
import { UserModel } from '../models'

dotenv.config({ path: path.join(__dirname, '../.env.local') })

@Service()
@Resolver()
class AuthResolvers {
    @Mutation(() => Boolean)
    async register(
        @Arg('name') name: string,
        @Arg('email') email: string,
        @Arg('password') password: string
    ): Promise<boolean> {
        try {
            const isUserExist = await UserModel.findOne({
                name: name.toLowerCase(),
            })
            if (isUserExist)
                throw new AuthenticationError('该昵称已被占用，换一个试试')
            const isEmailExist = await UserModel.findOne({
                email: email.toLowerCase(),
            })
            if (isEmailExist)
                throw new AuthenticationError('该邮箱已注册，请登录或找回密码')
            const username = shortId.generate()
            const profile = `${process.env.CLIENT_URL}/profile/${username}`
            const user = new UserModel({
                name,
                email,
                password,
                profile,
                username,
                role: '0',
            })

            await user.save()
            return true
        } catch (error: unknown) {
            console.log(error)
            return false
        }
    }

    @Mutation(() => LoginResponse)
    async login(
        @Arg('email') email: string,
        @Arg('password') password: string,
        @Ctx() context: TContext
    ): Promise<LoginResponse> {
        try {
            if (isEmpty(email)) throw new AuthenticationError('邮箱不得为空')
            if (isEmpty(password)) throw new AuthenticationError('密码不得为空')
            const user = await UserModel.findOne({ email })
            if (!user) throw new AuthenticationError('未找到邮箱，请先注册')

            const passwordMatches = user.authenticate(password)
            if (!passwordMatches)
                throw new AuthenticationError('邮箱和密码不匹配，请重新输入')

            const token = jwt.sign(
                { _id: user._id, role: user.role },
                process.env.JWT_SECRET!,
                { expiresIn: '7d' }
            )

            context.res.cookie('token', token, {
                httpOnly: true,
                maxAge: 1000 * 60 * 60 * 24 * 7,
            })

            return { accessToken: token }
        } catch (error) {
            console.log(error)
            return { accessToken: '' }
        }
    }
}

export default AuthResolvers
