import { decode } from 'jsonwebtoken'
import Container from 'typedi'

import { TContext, UserPayload } from '../../types'



export const context = (context: TContext) => {
    const requestId = Math.floor(
        Math.random() * Number.MAX_SAFE_INTEGER
    ).toString()
    const container = Container.of(requestId)

    const { req, res } = context
    const typeGraphQLContext = {
        req,
        user:
            req.headers['authorization'] &&
            req.headers['authorization'].split(' ')[0] === 'Bearer'
                ? (decode(
                      req.headers['authorization'].split(' ')[1]
                  ) as UserPayload)
                : null,
        requestId,
        container,
    }
    container.set('context', typeGraphQLContext)
    return { ...typeGraphQLContext, res }
}
