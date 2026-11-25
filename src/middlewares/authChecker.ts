import { AuthChecker, MiddlewareFn, ResolverData } from 'type-graphql'
import { TContext } from '../types'

export const authChecker: AuthChecker<TContext> = (
    { context: { user } }: ResolverData<TContext>,
    roles: string[]
) => {
    if (!user) return false
    if (roles.length === 0) return true

    return roles.includes(user.role)
}

export const isAdmin: MiddlewareFn<TContext> = ({ context }, next) => {
    if (!context.user) {
        throw new Error('Not Authenticated')
    }

    if (context.user.role !== '1') {
        throw new Error('Not Admin User')
    }

    return next()
}
