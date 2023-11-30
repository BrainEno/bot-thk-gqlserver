import { CategoryPopulated } from './category.interface'
import { TagPopulated } from './tag.interface'
import { UserPopulated } from './user.interface'

export type BlogPopulated = {
    _id: string
    title: string
    slug: string
    body?: string
    description?: string
    mtitle: string
    imageUri?: string
    author: UserPopulated
    tags?: TagPopulated[]
    categories?: CategoryPopulated[]
    createdAt: string
    updatedAt: string
    likedBy?: UserPopulated[]
}
