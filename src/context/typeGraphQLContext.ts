import jwt from 'jsonwebtoken';

import { TContext, UserPayload } from '../types';

const findUser = async (authToken: string) => {
  const currentUser = jwt.decode(authToken) as UserPayload;
  return currentUser;
};


export const context = async (context: TContext) => {
  const { req, res } = context;

  let token = '';
  if (req.cookies.botthk) {
    token = req.cookies.botthk;
  } else if (req.headers['cookie']) {
    token = req.headers['cookie'].split('botthk=')[1];
  } else if (req.headers['authorization']) {
    token = req.headers.authorization.split('Bearer ')[1];
  }

  const user = await findUser(token);

  const typeGraphQLContext = {
    req,
    user,
  };
  return { ...typeGraphQLContext, res };
};
