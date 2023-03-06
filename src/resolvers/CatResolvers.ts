import { Arg, Query, Resolver } from 'type-graphql'
import { Service } from 'typedi'
import { Blog } from '../entities/blog';

import { BlogModel, CategoryModel } from '../models'

@Service()
@Resolver()
class CatResolvers {
    @Query(() => [Blog])
    async getCatBlogs(@Arg('slug') slug: string): Promise<Blog[]> {
        try {
            const category = await CategoryModel.findOne({ slug: slug })
            if (category) {
                const blogs = await BlogModel.find({
                    $categories: { $search: category },
                })
                    .populate('categories', '_id name slug')
                    .populate('tags', '_id name slug')
                    .populate('author', 'name username profile')
                    .sort({ createdAt: -1 })
                    .select(
                        '_id title mtitle author body image imageUri slug description categories tags createdAt updatedAt active'
                    )
                    .exec();

                return blogs
            }
            return []
        } catch (error) {
            console.log(error)
            return []
        }
    }
}

export default CatResolvers
