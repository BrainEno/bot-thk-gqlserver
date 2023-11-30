export interface NewCommentPayload {
    commentedBy: string
    commentedAt: string
    dateTime: string
}

export interface ReplyCommentPayload {
    commentedBy: string
    repliedAt: string
    dateTime: string
}
