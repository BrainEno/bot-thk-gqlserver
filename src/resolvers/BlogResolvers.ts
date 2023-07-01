import { Arg, Ctx, Mutation, Query, Resolver } from 'type-graphql';

import { BlogInput, Blog } from '../entities/blog';
import { UserInputError } from 'apollo-server-express';
import { BlogModel, CategoryModel, TagModel, UserModel } from '../models';
import { isEmpty } from 'class-validator';
import { TContext } from '../types';
import { smartTrim } from '../utils/smartTrim';
import { NewBlogRes } from '../dtos/NewBlogRes';
import { Service } from 'typedi';
import { slugify } from '../utils/slugify';
import mongoose from 'mongoose';

@Service()
@Resolver()
class BlogResolvers {
  /**
   * get all blogs with it's categories and tags
   * @returns
   */
  @Query(() => [Blog])
  async listBlogsWithCatTag(): Promise<Blog[]> {
    try {
      const blogs = await BlogModel.find()
        .populate('categories', '_id name slug')
        .populate('tags', '_id name slug')
        .populate('author', '_id name username profile')
        .sort({ createdAt: -1 })
        .select(
          '_id title mtitle author body imageUri slug description categories tags createdAt updatedAt'
        )
        .exec();
      return blogs;
    } catch (error) {
      console.log(error);
      return [];
    }
  }

  /**
   * get a blog by it's slug
   * @param slug
   * @returns
   */
  @Query(() => Blog)
  async getBlogBySlug(@Arg('slug') slug: string): Promise<Blog> {
    try {
      if (isEmpty(slug)) {
        throw new UserInputError('slug can not be null');
      }
      const blog = await BlogModel.findOne({ slug: slug })
        .populate('categories', '_id name slug')
        .populate('tags', '_id name slug')
        .populate('author', '_id name username')
        .sort({ createdAt: -1 })
        .select(
          '_id title mtitle author body image imageUri slug description categories tags createdAt updatedAt active'
        )
        .exec();
      if (!blog) throw new Error(`not found blog with slug ${slug}`);
      return blog;
    } catch (err) {
      console.log(err);
      throw err;
    }
  }

  /**
   * get a blog by it's id
   * @param blogId
   * @returns
   */
  @Query(() => Blog)
  async getBlogById(@Arg('blogId') blogId: string): Promise<Blog> {
    try {
      if (isEmpty(blogId)) {
        throw new UserInputError('blogId can not be null');
      }
      const blog = await BlogModel.findOne({ _id: blogId })
        .populate('categories', '_id name slug')
        .populate('tags', '_id name slug')
        .populate('author', '_id name username')
        .sort({ createdAt: -1 })
        .select(
          '_id title mtitle author body imageUri slug description categories tags createdAt updatedAt active'
        )
        .exec();
      if (!blog) throw new Error(`not found blog with id ${blogId}`);
      return blog;
    } catch (err) {
      console.log(err);
      throw err;
    }
  }

  @Query(() => [Blog])
  async searchBlogs(@Arg('query') query: string): Promise<Blog[]> {
    try {
      const blogs = await BlogModel.find({
        $or: [
          { title: { $regex: query, $options: 'i' } },
          { body: { $regex: query, $options: 'i' } },
        ],
      })
        .populate('author', 'name')
        .select('slug title')
        .exec();

      if (!blogs) throw new Error(`blogs not found`);
      return blogs;
    } catch (err) {
      throw err;
    }
  }
  /**
   *
   * @param slug
   * @param catIds
   * @param tagIds
   * @param limit
   * @returns
   */
  @Query(() => [Blog])
  async getRelatedBlogs(
    @Arg('slug') slug: string,
    @Arg('catIds', () => [String]) catIds: string[],
    @Arg('tagIds', () => [String]) tagIds: string[],
    @Arg('limit', { nullable: true }) limit?: number
  ): Promise<Blog[]> {
    try {
      if (isEmpty(slug)) {
        throw new UserInputError('slug can not be null');
      }
      const blogs = await BlogModel.find({
        slug: { $ne: slug },
        tags: { $in: tagIds },
        categories: { $in: catIds },
      })
        .limit(limit ?? 3)
        .populate('tags', 'name slug')
        .populate('author', 'name')
        .select('slug title author imageUri  createdAt updatedAt tags')
        .exec();

      if (!blogs) throw new Error(`not found blogs related with slug ${slug}`);
      return blogs;
    } catch (err) {
      console.log(err);
      throw err;
    }
  }

  /**
   * get user blogs by userId
   * @param userId
   * @returns
   */
  @Query(() => [Blog])
  async getUserBlogs(@Arg('userId') userId: string): Promise<Blog[]> {
    try {
      if (isEmpty(userId)) {
        throw new UserInputError('userId can not be empty');
      }
      const blogs = await BlogModel.find({
        author: userId,
      })
        .populate('tags', 'name slug')
        .populate('author', 'name')
        .select('slug title author imageUri createdAt description')
        .exec();
      if (!blogs) throw new Error(`not found blogs belongs to user: ${userId}`);
      return blogs;
    } catch (err) {
      console.log(err);
      throw err;
    }
  }

  @Query(() => [Blog])
  async getBlogsByUsername(@Arg('username') username: string): Promise<Blog[]> {
    try {
      if (isEmpty(username)) {
        throw new UserInputError('username can not be empty');
      }
      const user = await UserModel.findOne({ username });
      const userId = user?._id;
      const blogs = await BlogModel.find({
        author: userId,
      })
        .populate('tags', 'name slug')
        .populate('author', 'name')
        .select('slug title author imageUri createdAt description')
        .sort({ createdAt: 1 })
        .exec();
      if (!blogs) throw new Error(`not found blogs belongs to user: ${userId}`);
      return blogs;
    } catch (err) {
      console.log(err);
      throw err;
    }
  }

  /**
   * Create a new blog
   * @param blog
   * @returns
   */
  @Mutation(() => NewBlogRes)
  async createBlog(
    @Ctx() { user }: TContext,
    @Arg('blogInput') blogInput: BlogInput,
    @Arg('tagIds', () => [String], { nullable: true }) tagIds?: string[]
  ): Promise<NewBlogRes> {
    if (!user) throw new Error('当前用户信息不可用，请重新登录');

    if (!blogInput) throw new Error('缺少必要信息，完善后重新提交');

    const { body, title, imageUri, active } = blogInput;

    const description = smartTrim(blogInput.body, 55, ' ', '...');

    const mtitle = `${title} | ${process.env.SITE_NAME ?? 'BOT THK'}`;
    const defaultTag = await TagModel.findOne({
      name: 'else',
    });

    const defaultCat = await CategoryModel.findOne({
      name: 'Recent Post',
    });

    const tags = tagIds && tagIds?.length ? strToRef(tagIds) : [defaultTag?._id];
    const categories = [defaultCat?._id];
    let slug = slugify(title);
    const slugExist = await BlogModel.findOne({ slug });
    if (!!slugExist) slug += '(1)';

    try {
      const newBlog = new BlogModel({
        description,
        author: user._id,
        title,
        body,
        mtitle,
        imageUri,
        active,
        tags,
        categories,
        slug,
      });

      await newBlog.save();
      return { success: true, blog: newBlog };
    } catch (error) {
      console.log(error);
      return { success: false, blog: null };
    }
  }

  @Mutation(() => NewBlogRes)
  async updateBlog(
    @Ctx() { user }: TContext,
    @Arg('blogId') blogId: string,
    @Arg('blogInput') blogInput: BlogInput,
    @Arg('tagIds', () => [String], { nullable: true }) tagIds?: string[]
  ): Promise<NewBlogRes> {
    if (!user) throw new Error('当前用户信息不可用，请重新登录');

    if (!blogInput) throw new Error('缺少必要信息，完善后重新提交');

    const prevBlog = await BlogModel.findOne({
      _id: blogId,
    });

    if (!prevBlog) throw new Error('加载草稿错误');

    const { body, title, imageUri, active } = blogInput;

    const description = smartTrim(
      blogInput.body ? blogInput.body : prevBlog.body,
      55,
      ' ',
      '...'
    );

    const mtitle = `${title || prevBlog.title} | ${
      process.env.SITE_NAME ?? 'BOT THK'
    }`;

    const defaultTag = await TagModel.findOne({
      name: 'else',
    });

    const tags = tagIds&&tagIds?.length ? strToRef(tagIds) : [defaultTag!._id!];
    let slug = slugify(title || prevBlog.title);
    const slugExist = await BlogModel.findOne({ slug });
    if (slugExist && slugExist._id.toString() !== blogId) slug += '(1)';

    prevBlog;
    try {
      if (title) prevBlog.title = title;
      if (body) prevBlog.body = body;
      if (imageUri) prevBlog.imageUri = imageUri;
      if (active !== prevBlog.active) prevBlog.active = active;
      if (tags) prevBlog.tags = tags as any;
      if (slug) prevBlog.slug = slug;
      if (mtitle) prevBlog.mtitle = mtitle;
      if (description) prevBlog.description = description;
      const newBlog = await prevBlog.save();
      return { success: true, blog: newBlog };
    } catch (error) {
      console.log(error);
      return { success: false, blog: null };
    }
  }

  @Mutation(() => Boolean)
  async deleteBlogById(
    @Ctx() { user }: TContext,
    @Arg('blogId') blogId: string
  ) {
    if (!user) throw new Error('当前用户信息不可用，请重新登录');
    const res = await BlogModel.findOneAndDelete({ _id: blogId });
    return res !== null;
  }
}

const strToRef = (ids: string[]) =>
  ids.map((id) => new mongoose.Types.ObjectId(id));

export default BlogResolvers;
