import {  ObjectType } from "type-graphql";
import { User } from "../entities/user";

@ObjectType()
export class UserDto extends User{
}
