import jwt from 'jsonwebtoken';

import { TContext, UserPayload } from '../types';
import dotenv from 'dotenv';

dotenv.config({ debug: process.env.NODE_ENV === 'development' });

const findUser = async (token: string) => {
  let user: UserPayload | null;
  try {
    user = jwt.verify(token, process.env.REFRESH_TOKEN_SECRET!) as UserPayload;
  } catch (error) {
    console.log('jwt verify error', error.message);
    user = null;
  }
  return user;
};

export const context = async (context: TContext) => {
  const { req, res } = context;

  let token = '';
  let user: TContext['user'] = null;
  if (req.cookies.botthk_refresh) {
    token = req.cookies.botthk_refresh;
  } else if (req.headers['cookie']) {
    token = req.headers['cookie'].split('botthk_refresh=')[1];
  } else if (req.headers['authorization']) {
    token = req.headers.authorization.split('Bearer ')[1];
  }

  if (token) {
    user = await findUser(token);
  }

  return { req, res, user };
};
