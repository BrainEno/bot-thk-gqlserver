import { ArgsType, Field } from 'type-graphql'

export enum ToggleLikeType {
    unknow = 'UNKWON',
    like = 'LIKE',
    unlike = 'UNLIKE',
}

@ArgsType()
export class SendLikeArgs {
    @Field(() => String)
    blogId: string

    @Field(() => String)
    likedBy: string
}

export interface NewLikePayload {
    likedBy: string
    blogTitle: string
    blogId: string
}
