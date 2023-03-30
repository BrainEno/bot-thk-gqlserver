import { Ctx, Query, Resolver } from 'type-graphql'

import { User } from '../entities/user'
import { MyContext } from '../types'
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
    async currentUser(@Ctx() { user }: MyContext): Promise<User | null> {
        try {
            if (!user) return null
            console.log(user)
            return await UserModel.findById(user._id)
        } catch (error) {
            console.log(error)
            return null
        }
    }
}

export default UserResolvers
