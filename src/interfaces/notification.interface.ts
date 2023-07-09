export interface NewFollowerPayload {
  followerName: string;
  followerUsername: string;
  followedName: string;
  dateString?: string;
}

export interface NewBlogPayload {
  authorUsername: string;
  authorName: string;
  authorId:string;
  blogSlug: string;
  blogTitle: string;
  dateString?: string;
}
