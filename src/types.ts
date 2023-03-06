import Container from 'typedi'
import { Request,Response } from 'express'
import { User } from './entities/user'

export type UserPayload = Pick<User, '_id' | 'role'>

export type TContext = {
    req: Request
    res: Response
    user: UserPayload | null
    requestId: string
    container: Container
}

