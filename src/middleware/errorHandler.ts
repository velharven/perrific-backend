import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { AppError } from '../lib/errors';
import { prisma } from '../lib/prisma';
import type { TeamRole } from '@prisma/client';

declare global {
  namespace Express {
    interface Request {
      userId?: string;
    }
  }
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ZodError) {
    return res.status(422).json({
      success: false,
      message: 'Validasi gagal',
      issues: err.issues,
    });
  }

  if (err instanceof AppError) {
    return res.status(err.statusCode).json({ success: false, message: err.message });
  }

  console.error('[error]', err);
  const message = err instanceof Error ? err.message : 'Terjadi kesalahan pada server';
  return res.status(500).json({ success: false, message });
}

export function requireTeamRole(teamId: string, userId: string, roles: TeamRole[]) {
  // helper untuk dipakai di service/controller
  return prisma.teamMember.findFirst({
    where: { teamId, userId, role: { in: roles } },
  });
}

export function notFoundHandler(_req: Request, res: Response) {
  return res.status(404).json({ success: false, message: 'Endpoint tidak ditemukan' });
}
