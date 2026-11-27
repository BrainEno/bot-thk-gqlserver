import { Types } from 'mongoose'

/**
 * Normalize an ObjectId value or populated Typegoose ref for Mongo query filters.
 * Mongoose casts string ids at runtime, but its latest query typings require an
 * ObjectId instance. Invalid ids still fail immediately rather than matching loosely.
 */
export const toObjectId = (value: unknown): Types.ObjectId => {
    if (value instanceof Types.ObjectId) return value

    if (typeof value === 'string') return new Types.ObjectId(value)

    if (value && typeof value === 'object' && '_id' in value) {
        return toObjectId((value as { _id: unknown })._id)
    }

    throw new TypeError('Expected a MongoDB ObjectId or populated reference')
}
