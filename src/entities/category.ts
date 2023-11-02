import { prop } from "@typegoose/typegoose";
import { Field, ObjectType } from "type-graphql";
import { ObjectIdScalar as ObjectId } from "../utils/ObjectIdScalar";
import { ObjectId as ObjectID } from "mongoose";
import { slugify } from "../utils/slugify";
import { TimeStamps } from "@typegoose/typegoose/lib/defaultClasses";

@ObjectType()
export class Category extends TimeStamps {
  @Field(() => ObjectId)
  readonly _id: ObjectID;

  @prop({ type: () => String, trim: true, required: true, maxlength: 32 })
  @Field({ nullable: false })
  name: string;

  @prop({ type: () => String, unique: true, index: true })
  @Field({ nullable: false })
  slug: string;

  makeSlug() {
    this.slug = slugify(this.name);
  }
}
