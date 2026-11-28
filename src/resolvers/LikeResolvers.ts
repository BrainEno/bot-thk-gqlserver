import { AuthenticationError } from '../errors/graphqlErrors'
import { publishEvent, Topic } from '../topic'
import { TContext } from '../types'
import { Arg, Ctx, Mutation, Resolver } from 'type-graphql'
import { Types } from 'mongoose'
import { BlogModel, UserModel } from '../models'

@Resolver()
export default class LikeResolvers {
    @Mutation(() => Boolean)
    async toggleLike(
        @Ctx() { user }: TContext,
        @Arg('blogId') blogId: string
    ) {
        if (!user) {
            throw new AuthenticationError('Not authorized')
        }

        const blog = await BlogModel.findOne({ _id: blogId })

        if (blog) {
            const existingLikers = await UserModel.find({ likedBlogs: blogId })
                .populate('_id')
                .exec()

            let existingLikerIds = existingLikers.length
                ? existingLikers.map((l) => l._id)
                : []

            const blogBeliked = existingLikerIds
                .map((i) => i.toString())
                .includes(user._id.toString())

            if (!blogBeliked) {
                existingLikerIds.push(user._id)
            } else {
                existingLikerIds = existingLikerIds.filter(
                    (i) => i.toString() !== user._id.toString()
                )
            }

            const liker = await UserModel.findOne({ _id: user._id })
            const existingLikedBlogs = await BlogModel.find({
                likedBy: user._id,
            })

            let likedBlogIds = existingLikedBlogs?.length
                ? (existingLikedBlogs.map(
                      (b) => b._id
                  ) as unknown as Types.ObjectId[])
                : ([] as Types.ObjectId[])


            const likedBlog =
                likedBlogIds &&
                likedBlogIds.map((i) => i.toString()).includes(blogId)

            if (!likedBlog) {
                likedBlogIds.push(new Types.ObjectId(blogId))
            } else {
                likedBlogIds = likedBlogIds.filter(
                    (i) => i.toString() !== blogId
                )
            }

            if (!liker) return false

            await blog.updateOne({
                likedBy: existingLikerIds,
            })
            await liker.updateOne({ likedBlogs: likedBlogIds })

            if (!blogBeliked && !likedBlog) {
                await publishEvent(Topic.NewLike, {
                    likedBy: user.name,
                    blogId: blog._id.toString(),
                    blogTitle: blog.title,
                })
            }

            return true
        } else {
            return false
        }
    }
}
