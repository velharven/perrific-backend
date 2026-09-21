import type { Request, Response } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { sendError } from '../lib/errors';

const columnType = z.enum(['TEXT', 'NUMBER', 'SELECT', 'DATE', 'CHECKBOX']);
const columnSchema = z.object({ id: z.string().uuid(), name: z.string().trim().min(1).max(80), type: columnType, icon: z.string().trim().min(1).max(30).nullish(), options: z.array(z.string().trim().min(1).max(60)).max(40).default([]), order: z.number() });
const rowSchema = z.object({ id: z.string().uuid(), noteId: z.string().uuid().nullable().optional(), values: z.record(z.unknown()), order: z.number() });
const updateSchema = z.object({ columns: z.array(columnSchema).max(50), rows: z.array(rowSchema).max(1000) });

async function findTable(noteId: string, userId: string) {
  return prisma.table.findFirst({
    where: { noteId, note: { userId, kind: 'TABLE' } },
    include: { columns: { orderBy: { order: 'asc' } }, rows: { orderBy: { order: 'asc' } }, note: true },
  });
}

export async function getTable(req: Request, res: Response) {
  if (!req.userId) return sendError(res, 401, 'Tidak terautentikasi');
  const table = await findTable(req.params.noteId, req.userId);
  if (!table) return sendError(res, 404, 'Tabel tidak ditemukan');
  return res.json({ success: true, data: table });
}

export async function updateTable(req: Request, res: Response) {
  if (!req.userId) return sendError(res, 401, 'Tidak terautentikasi');
  const table = await findTable(req.params.noteId, req.userId);
  if (!table) return sendError(res, 404, 'Tabel tidak ditemukan');
  const body = updateSchema.parse(req.body);
  // noteId yang ditautkan baris harus milik user yang sama (bukan note orang),
  // dan satu halaman hanya untuk satu baris.
  const linkedIds = [...new Set(body.rows.map((r) => r.noteId).filter((v): v is string => !!v))];
  if (body.rows.filter((r) => r.noteId).length !== linkedIds.length) {
    return sendError(res, 422, 'Satu halaman hanya untuk satu baris');
  }
  if (linkedIds.length > 0) {
    const owned = await prisma.note.count({ where: { id: { in: linkedIds }, userId: req.userId } });
    if (owned !== linkedIds.length) return sendError(res, 422, 'Tautan halaman baris tidak valid');
  }
  const existingColumnIds = new Set(table.columns.map((c) => c.id));
  const existingRowIds = new Set(table.rows.map((r) => r.id));
  const columnIds = new Set(body.columns.map((c) => c.id));
  const rowIds = new Set(body.rows.map((r) => r.id));
  await prisma.$transaction(async (tx) => {
    await tx.tableColumn.deleteMany({ where: { tableId: table.id, id: { notIn: [...columnIds] } } });
    await tx.tableRow.deleteMany({ where: { tableId: table.id, id: { notIn: [...rowIds] } } });
    for (const col of body.columns) {
      // options dipertahankan apa adanya (tak lagi di-wipe saat pindah dari
      // SELECT) agar pilihan tak lenyap diam-diam; render mengabaikannya.
      const data = { name: col.name, type: col.type, icon: col.icon ?? null, options: col.options, order: col.order };
      if (existingColumnIds.has(col.id)) await tx.tableColumn.update({ where: { id: col.id }, data });
      else await tx.tableColumn.create({ data: { id: col.id, tableId: table.id, ...data } });
    }
    for (const row of body.rows) {
      const values = JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(row.values).filter(([key]) => columnIds.has(key))))) as Prisma.InputJsonValue;
      const rowData = { values, order: row.order, noteId: row.noteId ?? null };
      if (existingRowIds.has(row.id)) await tx.tableRow.update({ where: { id: row.id }, data: rowData });
      else await tx.tableRow.create({ data: { id: row.id, tableId: table.id, ...rowData } });
    }
  });
  return getTable(req, res);
}
