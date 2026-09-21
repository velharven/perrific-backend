import type { Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { env } from '../config/env';

export async function health(_req: Request, res: Response) {
  let dbStatus = 'up';
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    dbStatus = 'down';
  }
  return res.json({
    success: true,
    data: { status: 'ok', environment: env.nodeEnv, database: dbStatus },
  });
}
