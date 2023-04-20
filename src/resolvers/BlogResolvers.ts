import { Arg, Mutation, Query, Resolver } from "type-graphql";
import { Service } from "typedi";

import { BlogInput, Blog } from "../entities/blog";
import { UserInputError } from "apollo-server-express";
import { BlogModel, UserModel } from "../models";
import { isEmpty } from "class-validator";

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
        .populate("categories", "_id name slug")
        .populate("tags", "_id name slug")
        .populate("author", "_id name username profile")
        .sort({ createdAt: -1 })
        .select(
          "_id title mtitle author body image imageUri slug description categories tags createdAt updatedAt"
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
  async getBlogBySlug(@Arg("slug") slug: string): Promise<Blog> {
    try {
      if (isEmpty(slug)) {
        throw new UserInputError("slug can not be null");
      }
      const blog = await BlogModel.findOne({ slug: slug })
        .populate("categories", "_id name slug")
        .populate("tags", "_id name slug")
        .populate("author", "_id name username")
        .sort({ createdAt: -1 })
        .select(
          "_id title mtitle author body image imageUri slug description categories tags createdAt updatedAt active"
        )
        .exec();
      if (!blog) throw new Error(`not found blog with slug ${slug}`);
      return blog;
    } catch (err) {
      console.log(err);
      throw err;
    }
  }

  @Query(() => [Blog])
  async searchBlogs(@Arg("query") query: string): Promise<Blog[]> {
    try {
      const blogs = await BlogModel.find({
        $or: [
          { title: { $regex: query, $options: "i" } },
          { body: { $regex: query, $options: "i" } },
        ],
      })
        .populate("author", "name")
        .select("slug title")
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
    @Arg("slug") slug: string,
    @Arg("catIds", () => [String]) catIds: string[],
    @Arg("tagIds", () => [String]) tagIds: string[],
    @Arg("limit", { nullable: true }) limit?: number
  ): Promise<Blog[]> {
    try {
      if (isEmpty(slug)) {
        throw new UserInputError("slug can not be null");
      }
      const blogs = await BlogModel.find({
        slug: { $ne: slug },
        tags: { $in: tagIds },
        categories: { $in: catIds },
      })
        .limit(limit ?? 3)
        .populate("tags", "name slug")
        .populate("author", "name")
        .select("slug title author imageUri  createdAt updatedAt tags")
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
  async getUserBlogs(@Arg("userId") userId: string): Promise<Blog[]> {
    try {
      if (isEmpty(userId)) {
        throw new UserInputError("userId can not be empty");
      }
      const blogs = await BlogModel.find({
        author: userId,
      })
        .populate("tags", "name slug")
        .populate("author", "name")
        .select("slug title author imageUri createdAt description")
        .exec();
      if (!blogs) throw new Error(`not found blogs belongs to user: ${userId}`);
      return blogs;
    } catch (err) {
      console.log(err);
      throw err;
    }
  }

  @Query(() => [Blog])
  async getBlogsByUsername(@Arg("username") username: string): Promise<Blog[]> {
    try {
      if (isEmpty(username)) {
        throw new UserInputError("username can not be empty");
      }
      const user = await UserModel.findOne({ username });
      const userId = user?._id;
      const blogs = await BlogModel.find({
        author: userId,
      })
        .populate("tags", "name slug")
        .populate("author", "name")
        .select("slug title author imageUri createdAt description")
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
  @Mutation(() => Blog)
  async createBlog(@Arg("blog") blog: BlogInput): Promise<Blog | null> {
    try {
      const newBlog = new BlogModel(blog as Blog);
      await newBlog.save();
      return newBlog;
    } catch (error) {
      console.log(error);
      return null;
    }
  }
}

export default BlogResolvers;
