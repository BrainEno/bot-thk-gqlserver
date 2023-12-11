import { Arg, Authorized, Mutation, Query, Resolver } from 'type-graphql'
import { Blog } from '../entities/blog'

import { BlogModel, CategoryModel } from '../models'
import { slugify } from '../utils/slugify'
import { Category } from '../entities/category'

@Resolver()
class CatResolvers {
    @Query(() => [Category])
    async listCats(): Promise<Category[]> {
        try {
            const cats = await CategoryModel.find()
            if (cats) return cats
            return []
        } catch (error) {
            console.log(error)
            return []
        }
    }

    @Query(() => [Blog])
    async getCatBlogs(@Arg('slug') slug: string): Promise<Blog[]> {
        try {
            const category = await CategoryModel.findOne({ slug: slug })
            if (category) {
                const blogs = await BlogModel.find({
                    categories: { $all: [category._id] },
                    active: true,
                })
                    .populate('categories', '_id name slug')
                    .populate('tags', '_id name slug')
                    .populate('author', 'name username profile')
                    .sort({ updatedAt: -1, createdAt: -1 })
                    .select(
                        '_id title mtitle author body imageUri slug description categories tags createdAt updatedAt active'
                    )
                    .exec()

                return blogs
            }
            return []
        } catch (error) {
            console.log(error)
            return []
        }
    }

    @Mutation(() => Boolean)
    async newCat(@Arg('catName') catName: string): Promise<boolean> {
        try {
            const isExist = await CategoryModel.findOne({ name: catName })
            if (isExist) throw new Error('tag exist')
            const newTag = await CategoryModel.create({
                name: catName,
                slug: slugify(catName),
            })
            return !!newTag
        } catch (error) {
            console.log(error)
            return false
        }
    }

    @Authorized('1')
    @Mutation(() => Boolean)
    async deleteCat(@Arg('id') id: string) {
        if (id) {
            await CategoryModel.deleteOne({ _id: id })
            return true
        }
        return false
    }
}

export default CatResolvers
