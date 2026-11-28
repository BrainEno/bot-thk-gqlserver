import {
    DocumentType,
    modelOptions,
    prop,
    Ref,
    Severity,
} from '@typegoose/typegoose'
import { IsEmail, Length, MaxLength, MinLength } from 'class-validator'
import { setPassword as hashAndSetPassword } from '../services/passwordService'
import { ObjectIdScalar as ObjectId } from '../utils/ObjectIdScalar'
import { Field, ObjectType } from 'type-graphql'
import { Comment } from './comment'
import { Types } from 'mongoose'
import { TimeStamps } from '@typegoose/typegoose/lib/defaultClasses'
import { Blog } from './blog'

@ObjectType()
@modelOptions({
    schemaOptions: { timestamps: true },
    options: { allowMixed: Severity.ALLOW },
})
export class User extends TimeStamps {
    @Field(() => ObjectId)
    readonly _id: Types.ObjectId

    @prop({
        type: () => String,
        trim: true,
        required: true,
        maxlength: 32,
        unique: true,
        index: true,
        lowercase: true,
    })
    @MinLength(1, { message: '用户名不能为空' })
    @Field({ nullable: false })
    username: string

    @prop({ type: () => String, trim: true, required: true, maxlength: 32 })
    @Field({ nullable: false })
    @MinLength(1, { message: '用户名不得为空' })
    @MaxLength(32)
    name: string

    @prop({
        type: () => String,
        trim: true,
        required: true,
        maxlength: 50,
        unique: true,
        lowercase: true,
    })
    @Field()
    @IsEmail()
    @Length(1, 50, { message: '邮箱地址不能为空' })
    email: string

    @prop({ type: () => String, required: true })
    @Field({ nullable: false })
    profile: string

    @prop({ type: () => String, required: true })
    hashed_password: string

    @prop({ type: () => String })
    salt: string

    @prop({ type: () => String, nullable: true })
    @Field({ nullable: true })
    about?: string

    @prop({ nullable: false, default: '0', trim: true })
    @Field()
    role: string

    @prop({
        default:
            'https://res.cloudinary.com/hapmoniym/image/upload/v1608712074/icons/avatar_w5us1g.png',
    })
    @Field({
        defaultValue:
            'https://res.cloudinary.com/hapmoniym/image/upload/v1608712074/icons/avatar_w5us1g.png',
    })
    photo: string

    // Keep persisted for compatibility, but never expose reset credentials via GraphQL.
    @prop({ default: '' })
    resetPasswordLink: string

    @prop({ ref: 'Comment' })
    @Field(() => [Comment])
    commented: Ref<Comment>[]

    @prop({ ref: 'Blog' })
    @Field(() => [Blog])
    likedBlogs: Ref<Blog>[]

    @prop({ ref: 'User' })
    @Field(() => [User])
    followings: Ref<User>[]

    @prop({ ref: 'User' })
    @Field(() => [User])
    followers: Ref<User>[]

    @prop(() => [String])
    @Field(() => [String])
    followingIds: string[]

    @prop(() => [String])
    @Field(() => [String])
    followerIds: string[]

    @Field(() => Date)
    createdAt: Date

    @Field(() => Date, { nullable: true })
    updatedAt?: Date

    @prop({ default: 0 })
    tokenVersion: number

    public get followingsCount() {
        return this.followings.length
    }

    public get followersCount() {
        return this.followers.length
    }

    public async addFollowingId(
        this: DocumentType<User>,
        newFollowingId: string
    ) {
        if (!this.followingIds) this.followingIds = []

        if (!this.followingIds.includes(newFollowingId))
            this.followingIds.push(newFollowingId)
    }

    public async removeFollowingId(
        this: DocumentType<User>,
        followingId: string
    ) {
        if (!this.followingIds) {
            this.followingIds = []
        }

        if (this.followingIds.includes(followingId))
            this.followingIds = this.followingIds.filter(
                (id) => id !== followingId
            )
    }

    public async addFollowerId(
        this: DocumentType<User>,
        newFollowingId: string
    ) {
        if (!this.followerIds) this.followerIds = []

        if (!this.followerIds.includes(newFollowingId))
            this.followerIds.push(newFollowingId)
    }

    public async removeFollowerId(
        this: DocumentType<User>,
        followerId: string
    ) {
        if (!this.followerIds) {
            this.followerIds = []
        }

        if (this.followerIds.includes(followerId))
            this.followerIds = this.followerIds.filter(
                (id) => id !== followerId
            )
    }

    public async updatePassword(
        this: DocumentType<User>,
        newPass: string
    ): Promise<void> {
        await hashAndSetPassword(this, newPass)
        await this.save()
    }
}
