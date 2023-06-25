import jwt from 'jsonwebtoken';
import Container from 'typedi';

import { TContext, UserPayload } from '../types';

export const context = async (context: TContext) => {
  const requestId = Math.floor(
    Math.random() * Number.MAX_SAFE_INTEGER
  ).toString();
  const container = Container.of(requestId);

  const { req, res } = context;

  let token = '';
  if (req.cookies.botthk) {
    token = req.cookies.botthk;
  } else if (req.headers['cookie']) {
    token = req.headers['cookie'].split('botthk=')[1];
  }

  const user = jwt.decode(token) as UserPayload;

  const typeGraphQLContext = {
    req,
    user,
    requestId,
    container,
  };
  container.set('context', typeGraphQLContext);
  return { ...typeGraphQLContext, res };
};
