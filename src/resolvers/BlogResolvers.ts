import {
    Arg,
    Ctx,
    Mutation,
    Publisher,
    PubSub,
    Query,
    Resolver,
    ResolverFilterData,
    Root,
    Subscription,
} from 'type-graphql'

import { BlogInput } from '../entities/blog'
import { UserInputError } from 'apollo-server-express'
import { BlogModel, CategoryModel, TagModel, UserModel } from '../models'
import { isEmpty } from 'class-validator'
import { TContext } from '../types'
import { smartTrim } from '../utils/smartTrim'
import {
    NewBlogResponse,
    PopulatedBlog,
    PopulatedCardBlog,
} from '../dtos/blogs'
import { slugify } from '../utils/slugify'
import mongoose from 'mongoose'
import { Topic } from '../topic'
import { NewBlogPayload } from '../interfaces/notification.interface'
import shortid from 'shortid'
import { Notification } from '../dtos/notification'
import { removeDuplicateObjects } from '../utils/removeDuplicateObjects'

@Resolver()
class BlogResolvers {
    /**
     * get all blogs with it's categories and tags
     * @returns
     */
    @Query(() => [PopulatedCardBlog])
    async listBlogsWithCatTag(): Promise<PopulatedCardBlog[]> {
        try {
            const blogs = await BlogModel.find({ active: true })
                .populate('categories', '_id name slug')
                .populate('tags', '_id name slug')
                .populate('author', '_id name username profile')
                .sort({ createdAt: -1 })
                .select(
                    '_id title mtitle author imageUri slug description categories tags createdAt updatedAt'
                )
                .exec()
            return blogs as unknown as PopulatedCardBlog[]
        } catch (error) {
            console.log(error)
            return []
        }
    }

    /**
     * get a blog by it's slug
     * @param slug
     * @returns
     */
    @Query(() => PopulatedBlog)
    async getBlogBySlug(@Arg('slug') slug: string): Promise<PopulatedBlog> {
        try {
            if (slug === undefined || isEmpty(slug)) {
                throw new UserInputError('slug can not be null')
            }

            const blog = (await BlogModel.findOne({ slug })
                .populate('categories', '_id name slug')
                .populate('tags', '_id name slug')
                .populate('author', '_id name username')
                .populate('likedBy', '_id name')
                .sort({ createdAt: -1 })
                .select(
                    '_id title mtitle author body image imageUri slug description categories tags createdAt updatedAt'
                )
                .exec()) as unknown as PopulatedBlog
            if (!blog) throw new Error(`not found blog with slug ${slug}`)
            return blog
        } catch (err) {
            console.log(err)
            throw err
        }
    }

    /**
     * get a blog by it's id
     * @param blogId
     * @returns
     */
    @Query(() => PopulatedBlog)
    async getBlogById(@Arg('blogId') blogId: string): Promise<PopulatedBlog> {
        try {
            if (isEmpty(blogId)) {
                throw new UserInputError('blogId can not be null')
            }
            const blog = await BlogModel.findOne({ _id: blogId })
                .populate('categories', '_id name slug')
                .populate('tags', '_id name slug')
                .populate('author', '_id name username')
                .populate('likedBy', '_id name')
                .sort({ createdAt: -1 })
                .select(
                    '_id title mtitle author body imageUri slug description categories tags createdAt updatedAt active'
                )
                .exec()
            if (!blog) throw new Error(`not found blog with id ${blogId}`)
            return blog as unknown as PopulatedBlog
        } catch (err) {
            console.log(err)
            throw err
        }
    }

    @Query(() => [PopulatedCardBlog])
    async searchBlogs(
        @Arg('query') query: string
    ): Promise<PopulatedCardBlog[]> {
        try {
            const titleBlogs = await BlogModel.find({
                title: { $regex: query, $options: 'i' },
                active: true,
            })
                .populate('author', 'name photo')
                .populate('tags', 'name slug')
                .select('slug title description createdAt tags imageUri')
                .exec()

            const decBlogs = await BlogModel.find({
                description: { $regex: query, $options: 'i' },
                active: true,
            })
                .populate('author', 'name photo')
                .populate('tags', 'name slug')
                .select('slug title description createdAt tags imageUri')
                .exec()

            const blogs = [...titleBlogs, ...decBlogs]
            const deduplicatedBlogs = removeDuplicateObjects(blogs, 'slug')

            if (!deduplicatedBlogs) throw new Error(`blogs not found`)
            return deduplicatedBlogs as unknown as PopulatedCardBlog[]
        } catch (err) {
            throw err
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
    @Query(() => [PopulatedCardBlog])
    async getRelatedBlogs(
        @Arg('slug') slug: string,
        @Arg('catIds', () => [String]) catIds: string[],
        @Arg('tagIds', () => [String]) tagIds: string[],
        @Arg('limit', { nullable: true }) limit?: number
    ): Promise<PopulatedCardBlog[]> {
        try {
            if (isEmpty(slug)) {
                throw new UserInputError('slug can not be null')
            }

            const blogs = await BlogModel.find({
                slug: { $ne: slug },
                tags: { $in: tagIds },
                categories: { $in: catIds },
                active: true,
            })
                .limit(limit ?? 3)
                .populate('tags', 'name slug')
                .select('slug title imageUri createdAt updatedAt tags')
                .exec()

            if (!blogs)
                throw new Error(`not found blogs related with slug ${slug}`)
            return blogs as unknown as PopulatedCardBlog[]
        } catch (err) {
            console.log(err)
            throw err
        }
    }

    /**
     * get user blogs by userId
     * @param userId
     * @returns
     */
    @Query(() => [PopulatedBlog])
    async getUserBlogs(
        @Arg('userId', { nullable: true }) userId?: string,
        @Arg('username', { nullable: true }) username?: string
    ): Promise<PopulatedBlog[]> {
        let id = userId
        try {
            if (isEmpty(userId) && !isEmpty(username)) {
                const user = await UserModel.findOne({ username })
                if (user) id = user._id.toString()
            } else if (!isEmpty(userId)) {
                id = userId!
            } else {
                throw new Error('paramter userId or username not found')
            }

            const blogs = (await BlogModel.find({
                author: id,
            })
                .populate('tags', 'name slug')
                .populate('categories', 'name slug')
                .populate('author', 'name username')
                .select(
                    '_id slug title tags categories author imageUri createdAt description active'
                )
                .sort({ createdAt: -1 })
                .exec()) as unknown as PopulatedBlog[]

            if (!blogs)
                throw new Error(`not found blogs belongs to user: ${userId}`)
            return blogs
        } catch (err) {
            console.log(err)
            throw err
        }
    }

    /**
     * get user blogs by userId
     * @param userId
     * @returns
     */
    @Query(() => [PopulatedBlog])
    async getUserLikedBlogs(
        @Ctx() { user }: TContext,
        @Arg('username', { nullable: true }) username?: string
    ): Promise<PopulatedBlog[]> {
        let id = ''

        try {
            if ((!user || isEmpty(user._id)) && !isEmpty(username)) {
                const user = await UserModel.findOne({ username })
                if (user) id = user._id.toString()
            } else if (user && user._id) {
                id = user._id.toString()
            } else {
                throw new Error('paramter userId or username not found')
            }

            const blogs = (await BlogModel.find({
                likedBy: id,
            })
                .populate('tags', 'name slug')
                .populate('categories', 'name slug')
                .populate('author', 'name username')
                .select(
                    '_id slug title tags categories author imageUri createdAt description active'
                )
                .sort({ createdAt: -1 })
                .exec()) as unknown as PopulatedBlog[]

            if (!blogs) throw new Error(`not found blogs liked by user: ${id}`)
            return blogs
        } catch (err) {
            console.log(err)
            throw err
        }
    }

    /**
     * Create a new blog
     * @param blog
     * @returns
     */
    @Mutation(() => NewBlogResponse)
    async createBlog(
        @Ctx() { user }: TContext,
        @Arg('blogInput') blogInput: BlogInput,
        @PubSub(Topic.NewNotification)
        notifyAboutNewBlog: Publisher<NewBlogPayload>,
        @Arg('tagIds', () => [String], { nullable: true }) tagIds?: string[]
    ): Promise<NewBlogResponse> {
        if (!user) throw new Error('用户信息不可用，请重新登录')

        const curUser = await UserModel.findOne({ _id: user._id })
        if (!curUser) throw new Error('未找到该用户,请重新登录')

        if (!blogInput) throw new Error('缺少必要信息，完善后重新提交')

        const { body, title, imageUri, active } = blogInput

        const description = smartTrim(blogInput.body, 55, ' ', '...')

        const mtitle = `${title} | ${process.env.SITE_NAME ?? 'BOT THK'}`
        const defaultTag = await TagModel.findOne({
            name: 'else',
        })

        const defaultCat = await CategoryModel.findOne({
            name: 'Recent Post',
        })

        const tags =
            tagIds && tagIds?.length ? strToRef(tagIds) : [defaultTag?._id]
        const categories = [defaultCat?._id]
        let slug = slugify(title)
        const slugExist = await BlogModel.findOne({ slug })
        if (!!slugExist) slug += '(1)'

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
            })

            const blog = (await newBlog.save()) as unknown as PopulatedBlog

            await notifyAboutNewBlog({
                blogSlug: blog.slug,
                authorUsername: curUser.username,
                blogTitle: blog.title,
                authorName: curUser.name,
                authorId:
                    typeof curUser._id === 'string'
                        ? curUser._id
                        : curUser._id.toString(),
            })

            return { success: true, blog }
        } catch (error) {
            console.log(error)
            return { success: false, blog: null }
        }
    }

    @Mutation(() => NewBlogResponse)
    async updateBlog(
        @Ctx() { user }: TContext,
        @Arg('blogId') blogId: string,
        @Arg('blogInput') blogInput: BlogInput,
        @Arg('tagIds', () => [String], { nullable: true }) tagIds?: string[]
    ): Promise<NewBlogResponse> {
        if (!user) throw new Error('当前用户信息不可用，请重新登录')

        if (!blogInput) throw new Error('缺少必要信息，完善后重新提交')

        const prevBlog = await BlogModel.findOne({
            _id: blogId,
        })

        if (!prevBlog) throw new Error('加载草稿错误')

        const { body, title, imageUri, active } = blogInput

        const description = smartTrim(
            blogInput.body ? blogInput.body : prevBlog.body,
            55,
            ' ',
            '...'
        )

        const mtitle = `${title || prevBlog.title} | ${
            process.env.SITE_NAME ?? 'BOT THK'
        }`

        const defaultTag = await TagModel.findOne({
            name: 'else',
        })

        const tags =
            tagIds && tagIds?.length ? strToRef(tagIds) : [defaultTag!._id!]
        let slug = slugify(title || prevBlog.title)
        const slugExist = await BlogModel.findOne({ slug })
        if (slugExist && slugExist._id.toString() !== blogId) slug += '(1)'

        prevBlog
        try {
            if (title) prevBlog.title = title
            if (body) prevBlog.body = body
            if (imageUri) prevBlog.imageUri = imageUri
            if (active !== prevBlog.active) prevBlog.active = active
            if (tags) prevBlog.tags = tags as any
            if (slug) prevBlog.slug = slug
            if (mtitle) prevBlog.mtitle = mtitle
            if (description) prevBlog.description = description

            const newBlog = (await prevBlog.save()) as unknown as PopulatedBlog

            return { success: true, blog: newBlog }
        } catch (error) {
            console.log(error)
            return { success: false, blog: null }
        }
    }

    @Mutation(() => Boolean)
    async deleteBlogById(
        @Ctx() { user }: TContext,
        @Arg('blogId') blogId: string
    ) {
        if (!user) throw new Error('当前用户信息不可用，请重新登录')
        const res = await BlogModel.findOneAndDelete({ _id: blogId })
        return res !== null
    }

    @Subscription(() => Notification, {
        topics: Topic.NewNotification,
        filter: ({
            payload,
            args,
        }: ResolverFilterData<NewBlogPayload, { followingIds: string[] }>) => {
            return args.followingIds.includes(payload.authorId)
        },
    })
    blogPublished(
        @Root() payload: NewBlogPayload,
        @Arg('followingIds', () => [String]) followingIds: string[]
    ): Notification {
        console.log('arg followingIds', followingIds)

        const message = `${payload.authorName}__${payload.blogTitle}`
        const linkString = `${payload.authorUsername}__${payload.blogSlug}`

        return {
            id: `blog_${shortid.generate()}`,
            message,
            linkString,
            dateString: payload.dateString ?? new Date().toISOString(),
        }
    }
}

const strToRef = (ids: string[]) =>
    ids.map((id) => new mongoose.Types.ObjectId(id))

export default BlogResolvers
