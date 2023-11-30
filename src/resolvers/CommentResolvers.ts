import {
    Arg,
    Ctx,
    Mutation,
    PubSub,
    Publisher,
    Query,
    Resolver,
} from 'type-graphql'
import { TContext } from '../types'
import { Topic } from '../topic'
import {
    NewCommentPayload,
    ReplyCommentPayload,
} from '../interfaces/comment.interface'
import { AuthenticationError } from 'apollo-server-express'
import { BlogModel } from '../models'
import { Comment, CommentModel } from '../entities/comment'

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
            console.log(error)
            return []
        }
    }

    @Mutation(() => Comment)
    async newComment(
        @Ctx() { user }: TContext,
        @Arg('content') content: string,
        @Arg('blogId') blogId: string,
        @PubSub(Topic.NewComment)
        notifyNewComment: Publisher<NewCommentPayload>
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

        notifyNewComment({
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
        @Arg('content') content: string,
        @PubSub(Topic.ReplyComment)
        notifyReplyComment: Publisher<ReplyCommentPayload>
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

        notifyReplyComment({
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
            const blog = await BlogModel.findOne({
                _id: commentToDel.atBlog,
            })
            if (!blog || !blog.comments) return
            const commentIds = blog.comments.filter(
                (cId) => cId.toString() !== commentToDel._id.toString()
            )

            await blog.updateOne({
                comments: commentIds,
            })
            return true
        }

        if (commentToDel.replyTo) {
            const toReply = await CommentModel.findOne({
                _id: commentToDel.replyTo,
            })
            if (!toReply || !toReply.replies) return

            const commentIds = toReply.replies.filter(
                (cId) => cId.toString() !== commentToDel._id.toString()
            )

            await toReply.updateOne({
                replies: commentIds,
            })

            return true
        }
        await commentToDel.deleteOne()

        return false
    }
}
