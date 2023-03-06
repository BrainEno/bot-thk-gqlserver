import { AuthChecker, ResolverData } from 'type-graphql'
import { TContext } from '../../types'


export const authChecker: AuthChecker<TContext> = (
    { context: { user } }: ResolverData<TContext>,
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
