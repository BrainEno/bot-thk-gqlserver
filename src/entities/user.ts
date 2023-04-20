import { prop, Ref } from "@typegoose/typegoose";
import { Exclude } from "class-transformer";
import { IsEmail, Length, MaxLength, MinLength } from "class-validator";
import crypto from "crypto";
import { ObjectId } from "bson";
import { Field, ObjectType } from "type-graphql";
import { Comment } from "./comment";
import { ObjectId as ObjectID } from "mongoose";

@ObjectType()
export class User {
  @Field(() => ObjectId)
  readonly _id: ObjectID;

  @prop({
    type: () => String,
    trim: true,
    required: true,
    maxlength: 32,
    unique: true,
    index: true,
    lowercase: true,
  })
  @MinLength(1, { message: "用户名不能为空" })
  @Field({ nullable: false })
  username: string;

  @prop({ type: () => String, trim: true, required: true, maxlength: 32 })
  @Field({ nullable: false })
  @MinLength(1, { message: "用户名不得为空" })
  @MaxLength(32)
  name: string;

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
  @Length(1, 50, { message: "邮箱地址不能为空" })
  email: string;

  @prop({ type: () => String, required: true })
  @Field({ nullable: false })
  profile: string;

  @prop({ type: () => String, required: true })
  hashed_password: string;

  @prop({ type: () => String })
  @Exclude()
  salt: string;

  @prop({ type: () => String, nullable: true })
  @Field({ nullable: true })
  about?: string;

  @prop({ nullable: false, default: "0", trim: true })
  @Field()
  role: string;

  @prop({
    default:
      "https://res.cloudinary.com/hapmoniym/image/upload/v1608712074/icons/avatar_w5us1g.png",
  })
  @Field({
    defaultValue:
      "https://res.cloudinary.com/hapmoniym/image/upload/v1608712074/icons/avatar_w5us1g.png",
  })
  photo: string;

  @Field(() => Date)
  createdAt: Date;

  @Field(() => Date)
  updatedAt?: Date;

  @prop({ default: "" })
  @Field({ defaultValue: "" })
  resetPasswordLink: string;

  @prop()
  _password: string;

  @prop({ ref: "Comment" })
  @Field(() => [Comment])
  commented: Ref<Comment>[];

  public set password(pw: string) {
    this._password = pw;
    this.salt = this.makeSalt();
    this.hashed_password = this.encryptPassword(pw);
  }

  public get password() {
    return this._password;
  }

  authenticate(plainText: string): boolean {
    return this.encryptPassword(plainText) === this.hashed_password;
  }

  makeSalt() {
    return Math.round(new Date().valueOf() * Math.random()) + "";
  }

  encryptPassword(password: string) {
    if (!password) return "";
    try {
      return crypto
        .createHmac("sha1", this.salt)
        .update(password)
        .digest("hex");
    } catch (error) {
      return "";
    }
  }
}
