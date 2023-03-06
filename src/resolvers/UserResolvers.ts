import { Ctx, Query, Resolver } from 'type-graphql'

import { User } from '../entities/user'
import { TContext } from '../types'
import { Service } from 'typedi'
import { UserModel } from '../models'

@Service()
@Resolver()
class UserResolvers {
    @Query(() => String)
    hello(): string {
        return 'Hello from userResolver'
    }

    @Query(() => User, { nullable: true })
    async currentUser(@Ctx() { user }: TContext): Promise<User | null> {
        try {
            if (user === null) return null
            return await UserModel.findById(user._id)
        } catch (error) {
            console.log(error)
            return null
        }
    }
}

export default UserResolvers
