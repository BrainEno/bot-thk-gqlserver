import { verify } from 'jsonwebtoken'
import { Request as SSERequest } from 'graphql-sse'
import type { Request, Response } from 'express'
import { TContext, UserPayload } from '../types'
import { extractBearerToken } from '../utils/authToken'

export const getDynamicContext = async (request: SSERequest) => {
    return { user: verifyAccessToken(request.headers.get('authorization')) }
}

export const context = async ({ req, res }: { req: Request; res: Response }): Promise<TContext> => {
    return {
        req,
        res,
        user: verifyAccessToken(req.headers.authorization),
    }
}

const verifyAccessToken = (authorization: string | null | undefined) => {
    const token = extractBearerToken(authorization)
    const secret = process.env.ACCESS_TOKEN_SECRET
    if (!token || !secret) return null

    try {
        return verify(token, secret) as UserPayload
    } catch {
        return null
    }
}
