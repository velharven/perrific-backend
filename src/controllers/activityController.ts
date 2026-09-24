import type { Request, Response } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { sendError } from '../lib/errors';
import {
  pushActivityToGoogleCalendar,
  deleteEventFromGoogleCalendar,
} from './googleCalendarController';
import { emitToUser } from '../lib/socket';

// ============ Helpers ============
function parseLocalDate(s: string): Date | null {
  const trimmed = s.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    const d = new Date(`${trimmed}T00:00:00`);
    return isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(trimmed);
  return isNaN(d.getTime()) ? null : d;
}

function parseDateRange(query: Record<string, unknown>) {
  const date = typeof query.date === 'string' ? query.date : undefined;
  const from = typeof query.from === 'string' ? query.from : undefined;
  const to = typeof query.to === 'string' ? query.to : undefined;

  let gte: Date | undefined;
  let lt: Date | undefined;

  if (date) {
    const d = parseLocalDate(date);
    if (d) {
      gte = new Date(d);
      gte.setHours(0, 0, 0, 0);
      gte = new Date(gte.getTime() - 14 * 60 * 60 * 1000);
      lt = new Date(d);
      lt.setHours(0, 0, 0, 0);
      lt.setDate(lt.getDate() + 1);
      lt = new Date(lt.getTime() + 14 * 60 * 60 * 1000);
    }
  } else if (from || to) {
    if (from) {
      const f = parseLocalDate(from);
      if (f) {
        gte = new Date(f);
        gte.setHours(0, 0, 0, 0);
        gte = new Date(gte.getTime() - 14 * 60 * 60 * 1000);
      }
    }
    if (to) {
      const t = parseLocalDate(to);
      if (t) {
        lt = new Date(t);
        lt.setHours(0, 0, 0, 0);
        lt.setDate(lt.getDate() + 1);
        lt = new Date(lt.getTime() + 14 * 60 * 60 * 1000);
      }
    }
  }

  return { gte, lt };
}

// ============ List (Notion-like, filter by date/search/status) ============
export async function listMyActivities(req: Request, res: Response) {
  if (!req.userId) return sendError(res, 401, 'Tidak terautentikasi');

  const { status, type, search } = req.query as {
    status?: string;
    type?: string;
    search?: string;
  };
  const { gte, lt } = parseDateRange(req.query as Record<string, unknown>);

  // Batas default agar riwayat tanpa filter tanggal tidak meledak;
  // bisa dioverride via ?limit= (maks 500).
  const rawLimit = Number((req.query as Record<string, unknown>).limit);
  const take =
    Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(Math.floor(rawLimit), 500)
      : 100;

  const where: Record<string, unknown> = { userId: req.userId };

  if (gte || lt) {
    (where as Record<string, unknown>).date = {
      ...(gte ? { gte } : {}),
      ...(lt ? { lt } : {}),
    };
  }
  if (status && ['PENDING', 'COMPLETED', 'SKIPPED'].includes(status)) {
    (where as Record<string, unknown>).status = status;
  }
  if (type && ['TASK', 'BREAKDOWN', 'CUSTOM'].includes(type)) {
    (where as Record<string, unknown>).type = type;
  }
  if (search && typeof search === 'string' && search.trim()) {
    (where as Record<string, unknown>).OR = [
      { title: { contains: search, mode: 'insensitive' } },
      { description: { contains: search, mode: 'insensitive' } },
    ];
  }

  const activities = await prisma.dailyActivity.findMany({
    where: where as never,
    orderBy: [{ order: 'asc' }, { date: 'asc' }, { startTime: 'asc' }, { createdAt: 'asc' }],
    include: {
      task: { select: { id: true, title: true, priority: true } },
      checklistItems: { orderBy: { order: 'asc' } },
    },
    take,
  });

  return res.json({ success: true, data: activities });
}

// ============ Create (supports inline checklist & icon/ordering) ============
const createActivitySchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  date: z.string().datetime().or(z.string().min(1)), // allow YYYY-MM-DD too
  startTime: z.string().datetime().optional().or(z.string().optional()),
  endTime: z.string().datetime().optional().or(z.string().optional()),
  type: z.enum(['TASK', 'BREAKDOWN', 'CUSTOM']).default('CUSTOM'),
  status: z.enum(['PENDING', 'COMPLETED', 'SKIPPED']).optional(),
  taskId: z.string().optional(),
  icon: z.string().max(8).optional(),
  order: z.number().optional(),
  createdAt: z.string().datetime().optional().or(z.string().optional()),
  customValues: z.record(z.union([z.string(), z.number(), z.boolean()])).nullable().optional(),
  checklist: z
    .array(z.object({ text: z.string().min(1) }))
    .optional(),
});

function parseOptionalDate(value?: string): Date | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (value === '') return null;
  const d = new Date(value);
  if (isNaN(d.getTime())) return undefined;
  return d;
}

export async function createActivity(req: Request, res: Response) {
  const body = createActivitySchema.parse(req.body);
  if (!req.userId) return sendError(res, 401, 'Tidak terautentikasi');

  const date = parseOptionalDate(body.date) as Date | undefined;
  if (!date) return sendError(res, 422, 'Format tanggal tidak valid');

  const createdAtDate = parseOptionalDate(body.createdAt);

  const activity = await prisma.dailyActivity.create({
    data: {
      userId: req.userId,
      title: body.title,
      description: body.description,
      date,
      startTime: parseOptionalDate(body.startTime) ?? null,
      endTime: parseOptionalDate(body.endTime) ?? null,
      type: body.type,
      status: body.status ?? 'PENDING',
      taskId: body.taskId,
      icon: body.icon,
      order: body.order ?? 0,
      createdAt: createdAtDate ?? undefined,
      customValues: (body.customValues ?? undefined) as unknown as Prisma.InputJsonValue | undefined,
      checklistItems: body.checklist
        ? {
            create: body.checklist.map((c, idx) => ({
              text: c.text,
              order: idx,
            })),
          }
        : undefined,
    },
    include: {
      checklistItems: { orderBy: { order: 'asc' } },
      task: { select: { id: true, title: true } },
    },
  });

  // Otomatis sinkronkan ke Google Calendar jika akun terhubung dan aktivitas memiliki jam pelaksanaan
  if (activity.startTime) {
    try {
      const gId = await pushActivityToGoogleCalendar(req.userId, activity.id);
      if (gId) activity.googleEventId = gId;
    } catch (err) {
      console.error('[activityController] Gagal auto-push ke Google Calendar:', err);
    }

    emitToUser(req.userId, 'calendar:synced', {
      action: 'create',
      activityId: activity.id,
      googleEventId: activity.googleEventId,
    });
  }

  return res.status(201).json({ success: true, data: activity });
}

// ============ Update ============
const updateActivitySchema = z.object({
  title: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  date: z.string().optional(),
  startTime: z.string().datetime().nullable().optional().or(z.string().nullable().optional()),
  endTime: z.string().datetime().nullable().optional().or(z.string().nullable().optional()),
  status: z.enum(['PENDING', 'COMPLETED', 'SKIPPED']).optional(),
  icon: z.string().max(8).nullable().optional(),
  order: z.number().optional(),
  type: z.enum(['TASK', 'BREAKDOWN', 'CUSTOM']).optional(),
});

export async function updateActivity(req: Request, res: Response) {
  if (!req.userId) return sendError(res, 401, 'Tidak terautentikasi');
  const body = updateActivitySchema.parse(req.body);

  const existing = await prisma.dailyActivity.findFirst({
    where: { id: req.params.activityId, userId: req.userId },
  });
  if (!existing) return sendError(res, 404, 'Aktivitas tidak ditemukan');

  const data: Record<string, unknown> = {};
  if (body.title !== undefined) data.title = body.title;
  if (body.description !== undefined) data.description = body.description;
  if (body.status !== undefined) data.status = body.status;
  if (body.icon !== undefined) data.icon = body.icon;
  if (body.order !== undefined) data.order = body.order;
  if (body.type !== undefined) data.type = body.type;
  if (body.date !== undefined) {
    const d = parseOptionalDate(body.date);
    if (d) data.date = d;
  }
  if (body.startTime !== undefined) {
    const v = body.startTime === null ? null : parseOptionalDate(body.startTime);
    data.startTime = v ?? null;
  }
  if (body.endTime !== undefined) {
    const v = body.endTime === null ? null : parseOptionalDate(body.endTime);
    data.endTime = v ?? null;
  }

  const activity = await prisma.dailyActivity.update({
    where: { id: req.params.activityId },
    data,
    include: {
      checklistItems: { orderBy: { order: 'asc' } },
      task: { select: { id: true, title: true } },
    },
  });

  // Otomatis sinkronkan pembaruan ke Google Calendar jika terhubung (tunggu agar googleEventId langsung tersedia)
  try {
    const gId = await pushActivityToGoogleCalendar(req.userId, activity.id);
    if (gId) activity.googleEventId = gId;
  } catch (err) {
    console.error('[activityController] Gagal auto-update ke Google Calendar:', err);
  }

  emitToUser(req.userId, 'calendar:synced', {
    action: 'update',
    activityId: activity.id,
    googleEventId: activity.googleEventId,
  });

  return res.json({ success: true, data: activity });
}

// Backward compat: typo alias
export const udpateActivity = updateActivity;

export async function deleteActivity(req: Request, res: Response) {
  if (!req.userId) return sendError(res, 401, 'Tidak terautentikasi');
  const existing = await prisma.dailyActivity.findFirst({
    where: { id: req.params.activityId, userId: req.userId },
  });
  if (!existing) return sendError(res, 404, 'Aktivitas tidak ditemukan');

  // Bersihkan event Google Calendar jika tertaut (tunggu agar tuntas di Google sebelum lanjut)
  if (existing.googleEventId) {
    try {
      await deleteEventFromGoogleCalendar(req.userId, existing.googleEventId);
    } catch (err) {
      console.error('[activityController] Gagal auto-delete dari Google Calendar:', err);
    }
  }

  await prisma.dailyActivity.delete({ where: { id: req.params.activityId } });
  emitToUser(req.userId, 'calendar:synced', {
    action: 'delete',
    activityId: req.params.activityId,
    googleEventId: existing.googleEventId,
  });
  return res.json({
    success: true,
    data: { id: req.params.activityId, googleEventId: existing.googleEventId },
  });
}

// ============ Checklist block (Notion-style sub-todos) ============
const addChecklistSchema = z.object({ text: z.string().min(1) });

export async function addChecklistItem(req: Request, res: Response) {
  if (!req.userId) return sendError(res, 401, 'Tidak terautentikasi');
  const body = addChecklistSchema.parse(req.body);
  const activityId = req.params.activityId;

  const activity = await prisma.dailyActivity.findFirst({
    where: { id: activityId, userId: req.userId },
  });
  if (!activity) return sendError(res, 404, 'Aktivitas tidak ditemukan');

  const maxOrder = await prisma.checklistItem.aggregate({
    where: { activityId },
    _max: { order: true },
  });

  const item = await prisma.checklistItem.create({
    data: {
      activityId,
      text: body.text,
      order: (maxOrder._max.order ?? -1) + 1,
    },
  });

  return res.status(201).json({ success: true, data: item });
}

const updateChecklistSchema = z.object({
  text: z.string().min(1).optional(),
  completed: z.boolean().optional(),
  order: z.number().optional(),
});

export async function updateChecklistItem(req: Request, res: Response) {
  if (!req.userId) return sendError(res, 401, 'Tidak terautentikasi');
  const body = updateChecklistSchema.parse(req.body);
  const itemId = req.params.itemId;

  const item = await prisma.checklistItem.findUnique({
    where: { id: itemId },
    include: { activity: true },
  });
  if (!item || item.activity.userId !== req.userId) return sendError(res, 404, 'Item tidak ditemukan');

  const updated = await prisma.checklistItem.update({
    where: { id: itemId },
    data: {
      ...(body.text !== undefined ? { text: body.text } : {}),
      ...(body.completed !== undefined ? { completed: body.completed } : {}),
      ...(body.order !== undefined ? { order: body.order } : {}),
    },
  });

  return res.json({ success: true, data: updated });
}

export async function deleteChecklistItem(req: Request, res: Response) {
  if (!req.userId) return sendError(res, 401, 'Tidak terautentikasi');
  const itemId = req.params.itemId;

  const item = await prisma.checklistItem.findUnique({
    where: { id: itemId },
    include: { activity: true },
  });
  if (!item || item.activity.userId !== req.userId) return sendError(res, 404, 'Item tidak ditemukan');

  await prisma.checklistItem.delete({ where: { id: itemId } });
  return res.json({ success: true, data: { id: itemId } });
}

// Reorder activities (drag-and-drop order persist)
const reorderSchema = z.object({
  orderedIds: z.array(z.string()).min(1),
});

export async function reorderActivities(req: Request, res: Response) {
  if (!req.userId) return sendError(res, 401, 'Tidak terautentikasi');
  const body = reorderSchema.parse(req.body);

  // verify all belong to user
  const count = await prisma.dailyActivity.count({
    where: { id: { in: body.orderedIds }, userId: req.userId },
  });
  if (count !== body.orderedIds.length) return sendError(res, 403, 'Beberapa aktivitas tidak valid');

  await prisma.$transaction(
    body.orderedIds.map((id, idx) =>
      prisma.dailyActivity.update({ where: { id }, data: { order: idx } }),
    ),
  );

  return res.json({ success: true, data: { orderedIds: body.orderedIds } });
}

// Duplicate an activity (Notion-style duplicate block)
export async function duplicateActivity(req: Request, res: Response) {
  if (!req.userId) return sendError(res, 401, 'Tidak terautentikasi');

  const source = await prisma.dailyActivity.findFirst({
    where: { id: req.params.activityId, userId: req.userId },
    include: { checklistItems: true },
  });
  if (!source) return sendError(res, 404, 'Aktivitas tidak ditemukan');

  const copy = await prisma.dailyActivity.create({
    data: {
      userId: req.userId,
      title: `${source.title} (copy)`,
      description: source.description,
      date: source.date,
      startTime: source.startTime,
      endTime: source.endTime,
      type: source.type,
      status: 'PENDING',
      icon: source.icon,
      order: source.order + 0.5,
      taskId: source.taskId,
      customValues: source.customValues ?? undefined,
      checklistItems: {
        create: source.checklistItems.map((c) => ({
          text: c.text,
          completed: false,
          order: c.order,
        })),
      },
    },
    include: {
      checklistItems: { orderBy: { order: 'asc' } },
      task: { select: { id: true, title: true } },
    },
  });

  return res.status(201).json({ success: true, data: copy });
}

const dailyColumnTypes = [
  'TEXT',
  'NUMBER',
  'DATE',
  'SELECT',
  'CHECKBOX',
  'STATUS',
  'PERSON',
  'FILES',
  'URL',
  'PHONE',
  'EMAIL',
  'CATEGORY',
  'START_TIME',
  'END_TIME',
] as const;

// ============ Daily custom columns (properti ala Notion, user-scoped) ============
const createColumnSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(60),
  type: z.enum(dailyColumnTypes).default('TEXT'),
  icon: z.string().max(8).optional(),
  options: z.array(z.string().trim().min(1).max(60)).max(50).optional(),
});

export async function listMyColumns(req: Request, res: Response) {
  if (!req.userId) return sendError(res, 401, 'Tidak terautentikasi');
  const columns = await prisma.dailyColumn.findMany({
    where: { userId: req.userId },
    orderBy: [{ order: 'asc' }, { createdAt: 'asc' }],
  });
  return res.json({ success: true, data: columns });
}

export async function createColumn(req: Request, res: Response) {
  if (!req.userId) return sendError(res, 401, 'Tidak terautentikasi');
  const body = createColumnSchema.parse(req.body);
  const maxOrder = await prisma.dailyColumn.aggregate({
    where: { userId: req.userId },
    _max: { order: true },
  });
  const column = await prisma.dailyColumn.create({
    data: {
      ...(body.id ? { id: body.id } : {}),
      userId: req.userId,
      name: body.name,
      type: body.type as any,
      icon: body.icon,
      ...(body.type === 'SELECT' ? { options: body.options ?? [] } : { options: Prisma.DbNull }),
      order: (maxOrder._max.order ?? -1) + 1,
    },
  });
  return res.status(201).json({ success: true, data: column });
}

const updateColumnSchema = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  type: z.enum(dailyColumnTypes).optional(),
  icon: z.string().max(8).nullable().optional(),
  options: z.array(z.string().trim().min(1).max(60)).max(50).optional(),
});

export async function updateColumn(req: Request, res: Response) {
  if (!req.userId) return sendError(res, 401, 'Tidak terautentikasi');
  const body = updateColumnSchema.parse(req.body);
  const existing = await prisma.dailyColumn.findFirst({
    where: { id: req.params.columnId, userId: req.userId },
  });
  if (!existing) return sendError(res, 404, 'Properti tidak ditemukan');

  const nextType = body.type ?? existing.type;
  const column = await prisma.dailyColumn.update({
    where: { id: existing.id },
    data: {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.type !== undefined ? { type: body.type as any } : {}),
      ...(body.icon !== undefined ? { icon: body.icon } : {}),
      // options hanya bermakna untuk SELECT; ganti tipe lain -> null
      ...(body.options !== undefined || body.type !== undefined
        ? nextType === 'SELECT'
          ? { options: body.options ?? [] }
          : { options: Prisma.DbNull }
        : {}),
    },
  });
  return res.json({ success: true, data: column });
}

export async function deleteColumn(req: Request, res: Response) {
  if (!req.userId) return sendError(res, 401, 'Tidak terautentikasi');
  const existing = await prisma.dailyColumn.findFirst({
    where: { id: req.params.columnId, userId: req.userId },
  });
  if (!existing) return sendError(res, 404, 'Properti tidak ditemukan');

  await prisma.dailyColumn.delete({ where: { id: existing.id } });

  // Bersihkan nilai properti dari semua aktivitas user (background-safe, skala personal)
  const acts = await prisma.dailyActivity.findMany({
    where: { userId: req.userId },
    select: { id: true, customValues: true },
  });
  const dirty = acts.filter((a) => {
    const v = (a.customValues ?? {}) as Record<string, unknown>;
    return v !== null && typeof v === 'object' && existing.id in v;
  });
  if (dirty.length > 0) {
    await prisma.$transaction(
      dirty.map((a) => {
        const v = { ...((a.customValues ?? {}) as Record<string, unknown>) };
        delete v[existing.id];
        return prisma.dailyActivity.update({
          where: { id: a.id },
          data: { customValues: v as unknown as Prisma.InputJsonValue },
        });
      }),
    );
  }

  return res.json({ success: true, data: { id: existing.id } });
}

const reorderColumnsSchema = z.object({
  orderedIds: z.array(z.string()).min(1),
});

export async function reorderColumns(req: Request, res: Response) {
  if (!req.userId) return sendError(res, 401, 'Tidak terautentikasi');
  const body = reorderColumnsSchema.parse(req.body);
  const count = await prisma.dailyColumn.count({
    where: { id: { in: body.orderedIds }, userId: req.userId },
  });
  if (count !== body.orderedIds.length) return sendError(res, 403, 'Beberapa properti tidak valid');
  await prisma.$transaction(
    body.orderedIds.map((id, idx) => prisma.dailyColumn.update({ where: { id }, data: { order: idx } })),
  );
  return res.json({ success: true, data: { orderedIds: body.orderedIds } });
}

// ============ Cell value (nilai properti per aktivitas) ============
const setCellValueSchema = z.object({
  columnId: z.string().min(1),
  value: z.unknown(),
});

function normalizeCellValue(
  type: string,
  options: unknown,
  value: unknown,
): { ok: boolean; normalized?: string | number | boolean | null; message?: string } {
  if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) {
    return { ok: true, normalized: null };
  }
  switch (type) {
    case 'PHONE':
      // Kolom telepon bisa menyimpan format apapun: teks huruf, angka acak, simbol, spasi, dsb.
      if (typeof value === 'string') return { ok: true, normalized: value };
      if (typeof value === 'number' || typeof value === 'boolean') return { ok: true, normalized: String(value) };
      return { ok: false, message: 'Nilai telepon tidak valid' };
    case 'TEXT':
      if (typeof value === 'string') return { ok: true, normalized: value };
      if (typeof value === 'number' || typeof value === 'boolean') return { ok: true, normalized: String(value) };
      return { ok: false, message: 'Nilai teks tidak valid' };
    case 'NUMBER':
      if (typeof value === 'number' && Number.isFinite(value)) return { ok: true, normalized: value };
      if (typeof value === 'string' && value.trim() !== '') {
        const num = Number(value);
        if (Number.isFinite(num)) return { ok: true, normalized: num };
      }
      return { ok: false, message: 'Nilai angka tidak valid' };
    case 'DATE': {
      if (typeof value !== 'string') return { ok: false, message: 'Nilai tanggal tidak valid' };
      const d = new Date(value);
      return isNaN(d.getTime()) ? { ok: false, message: 'Nilai tanggal tidak valid' } : { ok: true, normalized: value };
    }
    case 'SELECT': {
      const opts = Array.isArray(options) ? options.filter((o) => typeof o === 'string') : [];
      return typeof value === 'string' && opts.includes(value)
        ? { ok: true, normalized: value }
        : { ok: false, message: 'Pilihan tidak valid' };
    }
    case 'STATUS': {
      return typeof value === 'string'
        ? { ok: true, normalized: value }
        : { ok: false, message: 'Nilai status tidak valid' };
    }
    case 'PERSON': {
      if (typeof value === 'string') return { ok: true, normalized: value };
      if (typeof value === 'number') return { ok: true, normalized: String(value) };
      return { ok: false, message: 'Nilai orang tidak valid' };
    }
    case 'FILES': {
      if (typeof value === 'string') return { ok: true, normalized: value };
      return { ok: false, message: 'Nilai file tidak valid' };
    }
    case 'URL': {
      if (typeof value === 'string') return { ok: true, normalized: value };
      return { ok: false, message: 'Nilai URL tidak valid' };
    }
    case 'EMAIL': {
      if (typeof value === 'string') return { ok: true, normalized: value };
      return { ok: false, message: 'Nilai email tidak valid' };
    }
    case 'CATEGORY': {
      return typeof value === 'string'
        ? { ok: true, normalized: value }
        : { ok: false, message: 'Nilai kategori tidak valid' };
    }
    case 'START_TIME':
    case 'END_TIME': {
      if (typeof value === 'string') {
        return { ok: true, normalized: value };
      }
      return { ok: false, message: 'Nilai waktu tidak valid' };
    }
    case 'CHECKBOX':
      return typeof value === 'boolean' ? { ok: true, normalized: value } : { ok: false, message: 'Nilai centang tidak valid' };
    default:
      return { ok: false, message: 'Tipe properti tidak dikenal' };
  }
}

export async function setCellValue(req: Request, res: Response) {
  if (!req.userId) return sendError(res, 401, 'Tidak terautentikasi');
  const body = setCellValueSchema.parse(req.body);

  const activity = await prisma.dailyActivity.findFirst({
    where: { id: req.params.activityId, userId: req.userId },
  });
  if (!activity) return sendError(res, 404, 'Aktivitas tidak ditemukan');

  const column = await prisma.dailyColumn.findFirst({
    where: { id: body.columnId, userId: req.userId },
  });
  if (!column) return sendError(res, 404, 'Properti tidak ditemukan');

  const checked = normalizeCellValue(column.type, column.options, body.value);
  if (!checked.ok) return sendError(res, 422, checked.message ?? 'Nilai tidak valid');

  const current = ((activity.customValues ?? {}) as Record<string, unknown>) ?? {};
  const next = { ...current };
  if (checked.normalized === null || checked.normalized === undefined) delete next[column.id];
  else next[column.id] = checked.normalized;

  const updated = await prisma.dailyActivity.update({
    where: { id: activity.id },
    data: { customValues: next as unknown as Prisma.InputJsonValue },
    include: {
      checklistItems: { orderBy: { order: 'asc' } },
      task: { select: { id: true, title: true } },
    },
  });
  return res.json({ success: true, data: updated });
}
