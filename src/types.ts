import { Request, Response } from 'express';
import { User } from './entities/user';

export type UserPayload = Pick<User, '_id' | 'name' | 'role'>;

export type TContext = {
  req: Request;
  res: Response;
  user: UserPayload | null;
};
