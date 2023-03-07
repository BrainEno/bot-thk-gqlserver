import { prop } from '@typegoose/typegoose'
import { ObjectId }from 'bson'
import { Field, ObjectType } from 'type-graphql'
import { ObjectId as ObjectID } from 'mongoose'

@ObjectType()
export class Tag {
    @Field(() => ObjectId)
    readonly _id: ObjectID

    @prop({ type: () => String, trim: true, required: true, maxlength: 32 })
    @Field({ nullable: false })
    name: string

    @prop({ type: () => String, unique: true, index: true })
    @Field({ nullable: false })
    slug: string
}
