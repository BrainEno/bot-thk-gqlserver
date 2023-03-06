import { prop } from '@typegoose/typegoose'
import { ObjectId } from 'mongodb'
import { Field, ObjectType } from 'type-graphql'

import { slugify } from '../utils/slugify'

@ObjectType()
export class Category {
    @Field(() => ObjectId)
    readonly _id: ObjectId

    @prop({ type: () => String, trim: true, required: true, maxlength: 32 })
    @Field({ nullable: false })
    name: string

    @prop({ type: () => String, unique: true, index: true })
    @Field({ nullable: false })
    slug: string

    makeSlug() {
        this.slug = slugify(this.name)
    }
}
