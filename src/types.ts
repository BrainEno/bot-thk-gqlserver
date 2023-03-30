import Container from "typedi";
import { BaseContext } from "@apollo/server";
import { User } from "./entities/user";
import { Request, Response } from "express";

export type UserPayload = Pick<User, "_id" | "role">;

export interface MyContext extends BaseContext {
  req: Request;
  res: Response;
  user: UserPayload;
  requestId: string;
  container: Container;
}
