import jwt from 'jsonwebtoken';

import { TContext, UserPayload } from '../types';

const findUser = async (authToken: string) => {
  const user = jwt.decode(authToken) as UserPayload;
  return user;
};

export const tokenIsNotValid = (
  params: Record<string, unknown> | undefined
) => {
  return !params || !params.authentication || !params.Authorization;
};

export const getDynamicContext = async (ctx, _msg, _args) => {
  if (ctx.connectionParams.authentication) {
    const authToken = ctx.connectionParams.Authorization;
    console.log('authToken in ws ctx:', authToken);
    const currentUser = await findUser(authToken);
    return { currentUser };
  }
  return { currentUser: null };
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
