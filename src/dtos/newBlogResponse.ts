import { Field, ObjectType } from 'type-graphql';
import { Blog } from '../entities/blog';

@ObjectType()
export class NewBlogResponse {
  @Field()
  readonly success: boolean;

  blog: Blog | null;
}
