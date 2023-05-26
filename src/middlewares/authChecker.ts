import { AuthChecker, ResolverData } from 'type-graphql';
import { TContext } from '../types';

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
