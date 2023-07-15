import { Request, Response } from 'express';
import { User } from './entities/user';

export type UserPayload = Pick<
  User,
  '_id' | 'name' | 'role' | 'username' | 'tokenVersion'
>;

export type TContext = {
  req: Request;
  res: Response;
  user: UserPayload | null;
};
