import { verify } from 'jsonwebtoken';
import { AuthChecker, MiddlewareFn, ResolverData } from 'type-graphql';
import { TContext, UserPayload } from '../types';

export const authChecker: AuthChecker<TContext> = (
  { context: { user } }: ResolverData<TContext>,
  roles: string[]
) => {
  if (roles.length === 0) {
    return user !== undefined;
  }

  if (!user) {
    return false;
  }

  if (roles.some((role) => role === user.role)) {
    return true;
  }

  return false;
};

export const isAdmin: MiddlewareFn<TContext> = ({ context }, next) => {
  const authorization = context.req.headers.authorization;

  if (!authorization) {
    throw new Error('Not Authenticated');
  }

  try {
    const token = authorization.split(' ')[1];
    const payload = verify(token, process.env.ACCESS_TOKEN_SECRET!);
    context.user = payload as UserPayload;
    if (!context.user?.role.includes('1')) {
      throw new Error('Not Admin User');
    }
  } catch (err) {
    console.log(err);
    throw new Error('Not Admin User');
  }

  return next();
};
