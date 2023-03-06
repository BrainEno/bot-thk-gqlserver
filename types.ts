import Container from 'typedi'
import { User } from './entities/user'
import { Request,Response } from 'express'

export type UserPayload = Pick<User, '_id' | 'role'>

export type TContext = {
    req: Request
    res: Response
    user: UserPayload | null
    requestId: string
    container: Container
}

