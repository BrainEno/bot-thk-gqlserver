import { Response } from 'express';
import { sign } from 'jsonwebtoken';
import { User } from '../entities/user';
import dotenv from 'dotenv';

dotenv.config({ debug: process.env.NODE_ENV === 'development' });

export const createAccessToken = (user: User) =>
  sign(
    {
      _id: user._id,
      name: user.name,
      username: user.username,
      tokenVersion: user.tokenVersion,
      role: user.role,
    },
    process.env.ACCESS_TOKEN_SECRET!,
    {
      expiresIn: '15m',
    }
  );

export const createRefreshToken = (user: User) =>
  sign(
    {
      _id: user._id,
      name: user.name,
      username: user.username,
      tokenVersion: user.tokenVersion,
      role: user.role,
    },
    process.env.REFRESH_TOKEN_SECRET!,
    {
      expiresIn: '7d',
    }
  );

export const setRefreshToken = (res: Response, token: string) => {
  res.cookie('botthk_refresh', token, {
    httpOnly: true,
    sameSite: 'none',
    secure: true,
    maxAge: 60 * 60 * 24 * 7,
  });
};

export const setAccessToken = (res: Response, token: string) => {
  res.cookie('botthk', token, {
    httpOnly: true,
    sameSite: 'none',
    secure: true,
    maxAge: 60 * 15,
  });
};
