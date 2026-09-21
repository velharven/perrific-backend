import type { Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { sendError } from '../lib/errors';

export async function projectProgress(req: Request, res: Response) {
  const projectId = req.params.projectId;
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, name: true },
  });
  if (!project) return sendError(res, 404, 'Proyek tidak ditemukan');

  const columns = await prisma.boardColumn.findMany({
    where: { projectId },
    orderBy: { order: 'asc' },
    select: { id: true, name: true, order: true },
  });
  // Hitung di DB (GROUP BY) agar tidak memuat seluruh task ke memori.
  const groups = await prisma.task.groupBy({
    by: ['columnId'],
    where: { projectId },
    _count: { columnId: true },
  });
  const counts: Record<string, number> = {};
  for (const g of groups) counts[g.columnId] = g._count.columnId;
  const breakdown = columns.map((c) => ({ id: c.id, name: c.name, count: counts[c.id] ?? 0 }));
  const total = breakdown.reduce((sum, b) => sum + b.count, 0);
  // Kolom terakhir dianggap selesai (konvensi board kiri-ke-kanan).
  const done = breakdown.length > 0 ? breakdown[breakdown.length - 1].count : 0;

  return res.json({
    success: true,
    data: {
      project: { id: project.id, name: project.name },
      total,
      done,
      progress: total === 0 ? 0 : Math.round((done / total) * 100),
      columns: breakdown,
    },
  });
}

export async function myDailyProgress(req: Request, res: Response) {
  if (!req.userId) return sendError(res, 401, 'Tidak terautentikasi');
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayEnd = new Date(todayStart);
  todayEnd.setDate(todayEnd.getDate() + 1);

  const groups = await prisma.dailyActivity.groupBy({
    by: ['status'],
    where: { userId: req.userId, date: { gte: todayStart, lt: todayEnd } },
    _count: { status: true },
  });
  const counts: Record<string, number> = {};
  for (const g of groups) counts[g.status] = g._count.status;

  const completed = counts.COMPLETED ?? 0;
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
  const pending = total - completed;

  return res.json({
    success: true,
    data: {
      total,
      completed,
      pending,
      progress: total === 0 ? 0 : Math.round((completed / total) * 100),
    },
  });
}
