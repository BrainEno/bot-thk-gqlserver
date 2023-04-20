import { Arg, Mutation, Query, Resolver } from "type-graphql";
import { Service } from "typedi";
import { Blog } from "../entities/blog";
import { Tag } from "../entities/tag";

import { BlogModel, TagModel } from "../models";
import { slugify } from "../utils/slugify";

@Service()
@Resolver()
class TagResolvers {
  @Query(() => [Tag])
  async listTags(): Promise<Tag[]> {
    try {
      const tags = await TagModel.find();
      if (tags) return tags;
      return [];
    } catch (error) {
      console.log(error);
      return [];
    }
  }

  @Query(() => [Blog])
  async getTagBlogs(@Arg("slug") slug: string): Promise<Blog[]> {
    try {
      const tag = await TagModel.findOne({ slug: slug });
      if (tag) {
        const blogs = await BlogModel.find({
          tags: { $all: [tag._id] },
        })
          .populate("categories", "_id name slug")
          .populate("tags", "_id name slug")
          .populate("author", "name username profile")
          .sort({ createdAt: -1 })
          .select(
            "_id title mtitle author body imageUri slug description Tagegories tags createdAt updatedAt active"
          )
          .exec();

        return blogs;
      }
      return [];
    } catch (error) {
      console.log(error);
      return [];
    }
  }

  @Mutation(() => Boolean)
  async newTag(@Arg("tagName") tagName: string): Promise<boolean> {
    try {
      const isExist = await TagModel.findOne({ name: tagName });
      if (isExist) throw new Error("tag exist");
      const newTag = await TagModel.create({
        name: tagName,
        slug: slugify(tagName),
      });
      return !!newTag;
    } catch (error) {
      console.log(error);
      return false;
    }
  }
}

export default TagResolvers;
