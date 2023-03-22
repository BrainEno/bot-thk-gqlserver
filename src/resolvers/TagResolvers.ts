import { Arg, Query, Resolver } from "type-graphql";
import { Service } from "typedi";
import { Blog } from "../entities/blog";

import { BlogModel, TagModel } from "../models";

@Service()
@Resolver()
class TagResolvers {
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
}

export default TagResolvers;
