import { AuthChecker, ResolverData } from 'type-graphql'
import { MyContext } from '../types'


export const authChecker: AuthChecker<MyContext> = (
    { context: { user } }: ResolverData<MyContext>,
    roles: string[]
) => {
    if (roles&&roles.length === 0) {
        return user !== null
    }

    if (!user) {
        return false
    }

    if (user.role.split(',').some((role) => roles.includes(role))) {
        return true
    }

    return false
}
