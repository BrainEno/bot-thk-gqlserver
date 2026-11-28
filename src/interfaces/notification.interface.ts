export interface NewFollowerPayload {
  followerName: string;
  followerUsername: string;
  followedName: string;
  followedUserId: string;
  dateString?: string;
}

export interface NewBlogPayload {
  authorUsername: string;
  authorName: string;
  authorId:string;
  recipientUserIds: string[];
  blogSlug: string;
  blogTitle: string;
  dateString?: string;
}
