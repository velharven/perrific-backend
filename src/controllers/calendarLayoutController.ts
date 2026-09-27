import type { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { sendError } from '../lib/errors';
import { emitToUser } from '../lib/socket';

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}, 'Tanggal tidak valid');

const eventKeySchema = z.string().max(512).regex(/^(activity|google):\S+$/);

const saveSchema = z.object({
  columns: z.array(z.array(eventKeySchema).min(1)).min(2).max(200),
}).refine((value) => {
  const keys = value.columns.flat();
  return keys.length <= 200 && new Set(keys).size === keys.length;
}, 'Event tidak boleh berulang');

export async function listLayout(req: Request, res: Response) {
  if (!req.userId) return sendError(res, 401, 'Tidak terautentikasi');
  const { from, to } = z.object({ from: dateSchema, to: dateSchema }).parse(req.query);
  const spanDays = (Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / 86_400_000;
  if (spanDays < 0 || spanDays > 120) return sendError(res, 400, 'Rentang tanggal tidak valid');

  const rows = await prisma.calendarLayoutPreference.findMany({
    where: { userId: req.userId, date: { gte: from, lte: to } },
    select: { date: true, eventKey: true, position: true },
    orderBy: [{ date: 'asc' }, { position: 'asc' }, { eventKey: 'asc' }],
  });
  return res.json({ success: true, data: rows });
}

export async function saveLayout(req: Request, res: Response) {
  if (!req.userId) return sendError(res, 401, 'Tidak terautentikasi');
  const date = dateSchema.parse(req.params.date);
  const { columns } = saveSchema.parse(req.body);
  const userId = req.userId;

  await prisma.$transaction(columns.flatMap((eventKeys, position) => eventKeys.map((eventKey) =>
    prisma.calendarLayoutPreference.upsert({
      where: { userId_date_eventKey: { userId, date, eventKey } },
      create: { userId, date, eventKey, position },
      update: { position },
    }),
  )));

  emitToUser(userId, 'calendar:layout-updated', { date });
  return res.json({ success: true, data: { date, columns } });
}
