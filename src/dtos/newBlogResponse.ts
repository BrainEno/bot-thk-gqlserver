import { Field, ObjectType } from 'type-graphql';
import { Blog } from '../entities/blog';

@ObjectType()
export class NewBlogRes {
  @Field()
  readonly success: boolean;

  blog: Blog | null;
}
