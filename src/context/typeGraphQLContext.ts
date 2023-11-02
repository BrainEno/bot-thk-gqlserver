import { verify } from 'jsonwebtoken'
import { RequestParams, Request as SSERequest } from 'graphql-sse'
import { TContext, UserPayload } from '../types'
import dotenv from 'dotenv'

dotenv.config({ debug: process.env.NODE_ENV === 'development' })

export const getDynamicContext = async (
    request: SSERequest,
    params?: RequestParams
) => {
    console.log(params?.operationName)
    // console.log('req in sse context:', request.context,request.headers);

    const token = request.headers.get('authorization')
        ? request.headers.get('authorization')?.split('Bearer ')[1]
        : ''
    let user: TContext['user'] = null

    // console.log("token in sse ctx:", token);

    if (token) {
        try {
            user = verify(
                token,
                process.env.ACCESS_TOKEN_SECRET!
            ) as UserPayload
        } catch (error) {}
    }
    return { user }
}

export const context = async (context: TContext) => {
    const { req, res } = context
    // console.log("headers:", req.headers);
    // console.log("ctx authorization:", req.headers.authrization);

    let accessToken = ''
    let user: TContext['user'] = null

    if (req.headers['authrization']) {
        accessToken = (req.headers.authrization as string).split('Bearer ')[1]
    } else if (req.headers['authorization']) {
        accessToken = (req.headers.authorization as string).split('Bearer ')[1]
    }

    if (accessToken) {
        try {
            user = verify(
                accessToken,
                process.env.ACCESS_TOKEN_SECRET!
            ) as UserPayload
        } catch (error) {
            console.log('jwt  error in graphql context:', error)
        }
    }

    return { req, res, user }
}
