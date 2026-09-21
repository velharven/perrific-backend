import type { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { sendError } from '../lib/errors';

// Kamar bawaan tiap user: 1 dashboard + 1 daily berkunci acak.
// Dipanggil dari list agar user lama otomatis dapat tanpa migrasi data.
async function ensurePrivatDefaults(userId: string) {
  const kinds = await prisma.note.findMany({
    where: { userId, kind: { in: ['DASHBOARD', 'DAILY'] } },
    select: { kind: true },
  });
  const has = new Set(kinds.map((k) => k.kind));
  if (has.has('DASHBOARD') && has.has('DAILY')) return;

  const maxOrder = await prisma.note.aggregate({
    where: { userId },
    _max: { order: true },
  });
  let order = (maxOrder._max.order ?? -1) + 1;
  const toCreate: { kind: 'DASHBOARD' | 'DAILY'; title: string }[] = [];
  if (!has.has('DASHBOARD')) toCreate.push({ kind: 'DASHBOARD', title: 'Dashboard' });
  if (!has.has('DAILY')) toCreate.push({ kind: 'DAILY', title: 'Aktivitas Harian' });
  for (const item of toCreate) {
    await prisma.note.create({
      data: { userId, kind: item.kind, title: item.title, content: '', order: order++ },
    });
  }
}

// ============ List (tab catatan milik user, terurut) ============
export async function listMyNotes(req: Request, res: Response) {
  if (!req.userId) return sendError(res, 401, 'Tidak terautentikasi');
  await ensurePrivatDefaults(req.userId);
  const notes = await prisma.note.findMany({
    where: { userId: req.userId },
    orderBy: [{ order: 'asc' }, { updatedAt: 'desc' }],
  });
  return res.json({ success: true, data: notes });
}

// ============ Create (halaman catatan kosong / dashboard / daily) ============
const createNoteSchema = z.object({
  title: z.string().max(120).optional(),
  kind: z.enum(['NOTE', 'DASHBOARD', 'DAILY', 'TABLE']).optional(),
  parentId: z.string().uuid().nullable().optional(),
});

export async function createNote(req: Request, res: Response) {
  if (!req.userId) return sendError(res, 401, 'Tidak terautentikasi');
  const userId = req.userId;
  const body = createNoteSchema.parse(req.body);

  const parentId = body.parentId ?? null;
  if (parentId) {
    const parent = await prisma.note.findFirst({ where: { id: parentId, userId } });
    if (!parent) return sendError(res, 404, 'Halaman induk tidak ditemukan');
  }
  const maxOrder = await prisma.note.aggregate({
    where: { userId, parentId },
    _max: { order: true },
  });

  const kind = body.kind ?? 'NOTE';
  const defaultTitle = kind === 'DASHBOARD' ? 'Dashboard' : kind === 'DAILY' ? 'Aktivitas Harian' : kind === 'TABLE' ? 'Tabel tanpa judul' : 'Tanpa judul';
  const note = await prisma.$transaction(async (tx) => {
    const created = await tx.note.create({
    data: {
      userId,
      kind,
      parentId,
      title: body.title?.trim() ? body.title.trim() : defaultTitle,
      content: '',
      order: (maxOrder._max.order ?? -1) + 1,
    },
    });
    if (kind === 'TABLE') {
      // Tabel baru mulai dari 1 kolom Nama; properti lain via tombol +.
      await tx.table.create({
        data: {
          noteId: created.id,
          columns: { create: [{ name: 'Nama', type: 'TEXT', order: 0 }] },
        },
      });
    }
    return created;
  });
  return res.status(201).json({ success: true, data: note });
}

const moveNoteSchema = z.object({
  parentId: z.string().uuid().nullable(),
  beforeId: z.string().uuid().nullable().optional(),
});

export async function moveNote(req: Request, res: Response) {
  if (!req.userId) return sendError(res, 401, 'Tidak terautentikasi');
  const body = moveNoteSchema.parse(req.body);
  const note = await prisma.note.findFirst({ where: { id: req.params.noteId, userId: req.userId } });
  if (!note) return sendError(res, 404, 'Halaman tidak ditemukan');
  if (body.parentId === note.id) return sendError(res, 400, 'Halaman tidak dapat menjadi induknya sendiri');
  if (body.parentId) {
    const parent = await prisma.note.findFirst({ where: { id: body.parentId, userId: req.userId } });
    if (!parent) return sendError(res, 404, 'Halaman induk tidak ditemukan');
    let cursor: typeof parent | null = parent;
    while (cursor) {
      if (cursor.id === note.id) return sendError(res, 400, 'Tidak dapat memindahkan halaman ke turunannya');
      cursor = cursor.parentId ? await prisma.note.findFirst({ where: { id: cursor.parentId, userId: req.userId } }) : null;
    }
  }
  const siblings = await prisma.note.findMany({
    where: { userId: req.userId, parentId: body.parentId, NOT: { id: note.id } },
    orderBy: { order: 'asc' },
  });
  const before = body.beforeId ? siblings.findIndex((x) => x.id === body.beforeId) : -1;
  siblings.splice(before < 0 ? siblings.length : before, 0, note);
  await prisma.$transaction(siblings.map((item, order) => prisma.note.update({
    where: { id: item.id }, data: { parentId: body.parentId, order },
  })));
  const updated = await prisma.note.findUniqueOrThrow({ where: { id: note.id } });
  return res.json({ success: true, data: updated });
}

// ============ Get one (ownership check) ============
export async function getNote(req: Request, res: Response) {
  if (!req.userId) return sendError(res, 401, 'Tidak terautentikasi');
  const note = await prisma.note.findFirst({
    where: { id: req.params.noteId, userId: req.userId },
  });
  if (!note) return sendError(res, 404, 'Catatan tidak ditemukan');
  return res.json({ success: true, data: note });
}

// ============ Update (judul / isi / sampul) ============
const updateNoteSchema = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  content: z.string().max(100000).optional(),
  coverUrl: z.string().trim().max(400000).nullable().optional(),
});

export async function updateNote(req: Request, res: Response) {
  if (!req.userId) return sendError(res, 401, 'Tidak terautentikasi');
  const body = updateNoteSchema.parse(req.body);
  const existing = await prisma.note.findFirst({
    where: { id: req.params.noteId, userId: req.userId },
  });
  if (!existing) return sendError(res, 404, 'Catatan tidak ditemukan');

  const note = await prisma.note.update({
    where: { id: req.params.noteId },
    data: {
      ...(body.title !== undefined ? { title: body.title } : {}),
      ...(body.content !== undefined ? { content: body.content } : {}),
      ...(body.coverUrl !== undefined ? { coverUrl: body.coverUrl || null } : {}),
    },
  });
  return res.json({ success: true, data: note });
}

// ============ Delete ============
export async function deleteNote(req: Request, res: Response) {
  if (!req.userId) return sendError(res, 401, 'Tidak terautentikasi');
  const existing = await prisma.note.findFirst({
    where: { id: req.params.noteId, userId: req.userId },
  });
  if (!existing) return sendError(res, 404, 'Catatan tidak ditemukan');
  await prisma.note.delete({ where: { id: req.params.noteId } });
  return res.json({ success: true, data: { id: req.params.noteId } });
}
