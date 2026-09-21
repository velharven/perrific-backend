import type { NextFunction, Request, Response } from 'express';
import { verifyToken } from '../lib/jwt';
import { sendError } from '../lib/errors';

export function authRequired(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return sendError(res, 401, 'Token tidak ditemukan');
  }

  const token = authHeader.split(' ')[1];
  try {
    const payload = verifyToken(token);
    req.userId = payload.userId;
    next();
  } catch {
    return sendError(res, 401, 'Token tidak valid atau kedaluwarsa');
  }
}
