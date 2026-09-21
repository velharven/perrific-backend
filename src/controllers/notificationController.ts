import type { Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { sendError } from '../lib/errors';

// Batas default agar payload tetap kecil; notifikasi lama dibersihkan scheduler.
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

export async function listNotifications(req: Request, res: Response) {
  if (!req.userId) return sendError(res, 401, 'Tidak terautentikasi');
  const rawLimit = Number((req.query as Record<string, unknown>).limit);
  const take =
    Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(Math.floor(rawLimit), MAX_LIMIT)
      : DEFAULT_LIMIT;
  const notifications = await prisma.notification.findMany({
    where: { userId: req.userId },
    orderBy: { createdAt: 'desc' },
    take,
  });
  return res.json({ success: true, data: notifications });
}

export async function markRead(req: Request, res: Response) {
  if (!req.userId) return sendError(res, 401, 'Tidak terautentikasi');
  const notification = await prisma.notification.update({
    where: { id: req.params.notificationId },
    data: { read: true },
  });
  return res.json({ success: true, data: notification });
}
