import { logFailure } from '../services/LogService'
import {
    Arg,
    Ctx,
    Mutation,
    Query,
    Resolver,
} from 'type-graphql'
import { TContext } from '../types'
import { publishEvent, Topic } from '../topic'
import { AuthenticationError } from '../errors/graphqlErrors'
import { BlogModel } from '../models'
import { Comment, CommentModel } from '../entities/comment'
import { toObjectId } from '../utils/toObjectId'

@Resolver()
export default class CommentResolvers {
    @Query(() => [Comment])
    async blogComments(@Arg('blogId') blogId: string) {
        try {
            const comments = await CommentModel.find({ atBlog: blogId })
                .populate({
                    path: 'replies',
                    model: 'Comment',
                    populate: [
                        '_id content createdAt updatedAt',
                        {
                            path: 'by',
                            model: 'User',
                            populate: ['_id name photo'],
                        },
                    ],
                })
                .populate({
                    path: 'by',
                    model: 'User',
                    populate: ['_id name photo'],
                })
                .populate({
                    path: 'atBlog',
                    model: 'Blog',
                    populate: ['_id title'],
                })
                .populate('_id content createdAt updatedAt')
                .exec()
            if (comments) return comments
            return []
        } catch (error) {
            logFailure('resolver.comment.operation.failed', error)
            return []
        }
    }

    @Mutation(() => Comment)
    async newComment(
        @Ctx() { user }: TContext,
        @Arg('content') content: string,
        @Arg('blogId') blogId: string
    ) {
        if (!user) {
            throw new AuthenticationError('Not authorized')
        }

        const blogToUpdate = await BlogModel.findOne({ _id: blogId })

        if (!blogToUpdate) throw new Error('Blog not exisit')

        const comment = await new CommentModel({
            content,
            atBlog: blogId,
            by: user._id,
            createdAt: new Date(),
        }).save()

        const existingComments = await CommentModel.find({
            atBlog: blogId,
        }).sort([['createdAt', 'asc']])

        const commentIds = existingComments
            ? existingComments.map((c) => c._id)
            : []

        if (commentIds.map((id) => id !== comment._id))
            commentIds.push(comment._id)

        await blogToUpdate.updateOne({ comments: commentIds })

        await publishEvent(Topic.NewComment, {
            commentedAt: blogId,
            commentedBy: user._id.toString(),
            dateTime: comment.createdAt.toString(),
        })

        await comment.populate({
            path: 'by',
            model: 'User',
            populate: ['_id name photo'],
        })

        await comment.populate({
            path: 'atBlog',
            model: 'Blog',
            populate: ['_id title'],
        })

        return comment
    }

    @Mutation(() => Comment)
    async replyComment(
        @Ctx() { user }: TContext,
        @Arg('commentId') commentId: string,
        @Arg('content') content: string
    ) {
        if (!user) {
            throw new AuthenticationError('Not authorized')
        }

        const toReply = await CommentModel.findOne({ _id: commentId })

        if (!toReply) throw new Error('Comment not exisit')

        const comment = await new CommentModel({
            content,
            replyTo: commentId,
            by: user._id,
            createdAt: new Date(),
        }).save()

        const existingComments = await CommentModel.find({
            replies: commentId,
        }).sort([['createdAt', 'asc']])

        const commentIds = existingComments
            ? existingComments.map((c) => c._id)
            : []

        commentIds.push(comment._id)

        await toReply.updateOne({ replies: commentIds })

        await publishEvent(Topic.ReplyComment, {
            repliedAt: commentId,
            commentedBy: user._id.toString(),
            dateTime: comment.createdAt.toString(),
        })

        await comment.populate({
            path: 'by',
            model: 'User',
            populate: ['_id name photo'],
        })

        await comment.populate({
            path: 'replyTo',
            model: 'Comment',
            populate: ['_id'],
        })

        return comment
    }

    @Mutation(() => Boolean)
    async deleteComment(
        @Ctx() { user }: TContext,
        @Arg('commentId') commentId: string
    ) {
        if (!user) {
            throw new AuthenticationError('Not authorized')
        }

        const commentToDel = await CommentModel.findById({
            _id: commentId,
        })
            .populate({
                path: 'by',
                model: 'User',
                populate: ['_id name'],
            })
            .populate({
                path: 'atBlog',
                model: 'Blog',
                populate: ['_id title'],
            })
            .populate('_id content createdAt updatedAt')
            .exec()

        if (!commentToDel) return false

        if (user._id.toString() !== commentToDel.by._id.toString()) {
            throw new AuthenticationError('Access denied')
        }

        if (commentToDel.atBlog) {
            const blogId = toObjectId(commentToDel.atBlog)
            const blog = await BlogModel.findOne({ _id: blogId })
            if (!blog || !blog.comments) return
            const commentIds = blog.comments.filter(
                (cId) => cId.toString() !== commentToDel._id.toString()
            )

            await BlogModel.updateOne(
                { _id: blog._id },
                { comments: commentIds }
            )
            return true
        }

        if (commentToDel.replyTo) {
            const replyId = toObjectId(commentToDel.replyTo)
            const toReply = await CommentModel.findOne({ _id: replyId })
            if (!toReply || !toReply.replies) return

            const commentIds = toReply.replies.filter(
                (cId) => cId.toString() !== commentToDel._id.toString()
            )

            await CommentModel.updateOne(
                { _id: toReply._id },
                { replies: commentIds }
            )

            return true
        }
        await commentToDel.deleteOne()

        return false
    }
}
