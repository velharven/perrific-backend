import type { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { sendError } from '../lib/errors';
import { assigneesInclude, columnSelect, createdBySelect, uniqIds, watchersInclude, withAssignees, withWatchers } from '../lib/taskAssignees';

export async function getTask(req: Request, res: Response) {
  const task = await prisma.task.findUnique({
    where: { id: req.params.taskId },
    include: {
      ...assigneesInclude,
      ...watchersInclude,
      ...createdBySelect,
      ...columnSelect,
      comments: true,
      attachments: { orderBy: { createdAt: 'asc' } },
    },
  });
  if (!task) return sendError(res, 404, 'Task tidak ditemukan');
  return res.json({ success: true, data: withWatchers(withAssignees(task)) });
}

const updateTaskSchema = z.object({
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  columnId: z.string().min(1).optional(),
  priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).optional(),
  assigneeIds: z.array(z.string()).optional(),
  dueDate: z.string().datetime().optional(),
  order: z.number().optional(),
});

// Geser/ubah task boleh semua anggota tim; buat & hapus khusus ADMIN.
async function requireTaskMembership(taskId: string, userId?: string) {
  const task = await prisma.task.findUnique({
    where: { id: taskId },
    include: { project: { select: { teamId: true } } },
  });
  if (!task) return { error: 404 as const };
  if (!userId) return { error: 401 as const };
  const membership = await prisma.teamMember.findFirst({
    where: { teamId: task.project.teamId, userId },
  });
  if (!membership) return { error: 403 as const };
  return { membership };
}

export async function updateTask(req: Request, res: Response) {
  const body = updateTaskSchema.parse(req.body);
  const checked = await requireTaskMembership(req.params.taskId, req.userId);
  if ('error' in checked) {
    return checked.error === 404
      ? sendError(res, 404, 'Task tidak ditemukan')
      : checked.error === 401
        ? sendError(res, 401, 'Tidak terautentikasi')
        : sendError(res, 403, 'Bukan anggota tim ini');
  }
  const { assigneeIds, columnId, ...rest } = body;
  const before = await prisma.task.findUnique({
    where: { id: req.params.taskId },
    select: {
      projectId: true,
      columnId: true,
      approval: true,
      assignees: { select: { userId: true } },
      column: { select: { name: true } },
    },
  });
  if (!before) return sendError(res, 404, 'Task tidak ditemukan');
  // Task usulan yang belum disetujui tidak boleh pindah kolom (drag kanban).
  if (columnId && before.approval !== 'APPROVED' && columnId !== before.columnId) {
    return sendError(res, 422, 'Task belum disetujui admin sehingga belum bisa dipindah');
  }
  // Task yang ditolak hanya boleh diubah admin (kreator tak terlacak di model).
  if (before.approval === 'REJECTED' && checked.membership.role !== 'ADMIN') {
    return sendError(res, 403, 'Task yang ditolak hanya bisa diubah admin');
  }
  if (columnId && columnId !== before.columnId) {
    const target = await prisma.boardColumn.findFirst({
      where: { id: columnId, projectId: before.projectId },
    });
    if (!target) return sendError(res, 422, 'Kolom tidak valid');
  }
  const task = await prisma.task.update({
    where: { id: req.params.taskId },
    data: {
      ...rest,
      ...(columnId ? { columnId } : {}),
      dueDate: body.dueDate ? new Date(body.dueDate) : undefined,
      ...(assigneeIds !== undefined
        ? { assignees: { deleteMany: {}, create: uniqIds(assigneeIds).map((userId) => ({ userId })) } }
        : {}),
    },
    include: { ...assigneesInclude, ...watchersInclude, ...createdBySelect, ...columnSelect },
  });
  // Catat riwayat untuk tab Activities: pindah card & perubahan assignee.
  const actorId = req.userId!;
  const logs: { kind: 'MOVED' | 'ASSIGNED' | 'UNASSIGNED'; fromColumn?: string | null; toColumn?: string | null; targetUserId?: string }[] = [];
  if (before && columnId && columnId !== before.columnId) {
    const target = await prisma.boardColumn.findUnique({ where: { id: columnId }, select: { name: true } });
    logs.push({ kind: 'MOVED', fromColumn: before.column?.name ?? null, toColumn: target?.name ?? null });
  }
  if (assigneeIds !== undefined && before) {
    const oldIds = before.assignees.map((a) => a.userId);
    const newIds = uniqIds(assigneeIds);
    for (const userId of newIds.filter((id) => !oldIds.includes(id))) {
      logs.push({ kind: 'ASSIGNED', targetUserId: userId });
    }
    for (const userId of oldIds.filter((id) => !newIds.includes(id))) {
      logs.push({ kind: 'UNASSIGNED', targetUserId: userId });
    }
  }
  if (logs.length > 0) {
    await prisma.taskActivity.createMany({
      data: logs.map((l) => ({ taskId: task.id, actorId, ...l })),
    });
  }
  return res.json({ success: true, data: withWatchers(withAssignees(task)) });
}

export async function deleteTask(req: Request, res: Response) {
  const checked = await requireTaskMembership(req.params.taskId, req.userId);
  if ('error' in checked) {
    return checked.error === 404
      ? sendError(res, 404, 'Task tidak ditemukan')
      : checked.error === 401
        ? sendError(res, 401, 'Tidak terautentikasi')
        : sendError(res, 403, 'Bukan anggota tim ini');
  }
  if (checked.membership.role !== 'ADMIN') return sendError(res, 403, 'Hanya admin tim yang bisa menghapus task');
  await prisma.task.delete({ where: { id: req.params.taskId } });
  return res.json({ success: true, data: { id: req.params.taskId } });
}

const addCommentSchema = z.object({ content: z.string().min(1) });

export async function addComment(req: Request, res: Response) {
  const body = addCommentSchema.parse(req.body);
  if (!req.userId) return sendError(res, 401, 'Tidak terautentikasi');
  const comment = await prisma.comment.create({
    data: { taskId: req.params.taskId, authorId: req.userId, content: body.content },
    include: { author: { select: { id: true, name: true } } },
  });
  return res.status(201).json({ success: true, data: comment });
}

export async function listComments(req: Request, res: Response) {
  const comments = await prisma.comment.findMany({
    where: { taskId: req.params.taskId },
    orderBy: { createdAt: 'asc' },
    include: { author: { select: { id: true, name: true, avatarUrl: true } } },
  });
  return res.json({ success: true, data: comments });
}

const updateCommentSchema = z.object({ content: z.string().min(1) });

async function requireCommentAuthor(taskId: string, commentId: string, userId?: string) {
  if (!userId) return { error: 401 as const };
  const comment = await prisma.comment.findUnique({ where: { id: commentId } });
  if (!comment || comment.taskId !== taskId) return { error: 404 as const };
  const membership = await prisma.teamMember.findFirst({
    where: { userId, team: { projects: { some: { tasks: { some: { id: taskId } } } } } },
  });
  if (!membership) return { error: 403 as const };
  if (comment.authorId !== userId) return { error: 403 as const, reason: 'author' as const };
  return { comment };
}

// Ubah/hapus komentar hanya oleh penulisnya.
export async function updateComment(req: Request, res: Response) {
  const body = updateCommentSchema.parse(req.body);
  const checked = await requireCommentAuthor(req.params.taskId, req.params.commentId, req.userId);
  if ('error' in checked) {
    return checked.error === 404
      ? sendError(res, 404, 'Komentar tidak ditemukan')
      : checked.error === 401
        ? sendError(res, 401, 'Tidak terautentikasi')
        : 'reason' in checked && checked.reason === 'author'
          ? sendError(res, 403, 'Hanya penulis komentar yang bisa mengubah')
          : sendError(res, 403, 'Bukan anggota tim ini');
  }
  const updated = await prisma.comment.update({
    where: { id: req.params.commentId },
    data: { content: body.content },
    include: { author: { select: { id: true, name: true, avatarUrl: true } } },
  });
  return res.json({ success: true, data: updated });
}

export async function deleteComment(req: Request, res: Response) {
  const checked = await requireCommentAuthor(req.params.taskId, req.params.commentId, req.userId);
  if ('error' in checked) {
    return checked.error === 404
      ? sendError(res, 404, 'Komentar tidak ditemukan')
      : checked.error === 401
        ? sendError(res, 401, 'Tidak terautentikasi')
        : 'reason' in checked && checked.reason === 'author'
          ? sendError(res, 403, 'Hanya penulis komentar yang bisa menghapus')
          : sendError(res, 403, 'Bukan anggota tim ini');
  }
  await prisma.comment.delete({ where: { id: req.params.commentId } });
  return res.json({ success: true, data: { id: req.params.commentId } });
}

export async function listActivities(req: Request, res: Response) {
  const checked = await requireTaskMembership(req.params.taskId, req.userId);
  if ('error' in checked) {
    return checked.error === 404
      ? sendError(res, 404, 'Task tidak ditemukan')
      : checked.error === 401
        ? sendError(res, 401, 'Tidak terautentikasi')
        : sendError(res, 403, 'Bukan anggota tim ini');
  }
  const items = await prisma.taskActivity.findMany({
    where: { taskId: req.params.taskId },
    orderBy: { createdAt: 'desc' },
    include: {
      actor: { select: { id: true, name: true, avatarUrl: true } },
      targetUser: { select: { id: true, name: true, avatarUrl: true } },
    },
  });
  return res.json({ success: true, data: items });
}

const addAttachmentSchema = z.object({
  filename: z.string().trim().min(1).max(255),
  mimeType: z.string().trim().min(1).max(127),
  size: z.number().int().positive().max(5 * 1024 * 1024),
  dataUrl: z.string().max(7 * 1024 * 1024),
});

export async function addAttachment(req: Request, res: Response) {
  const body = addAttachmentSchema.parse(req.body);
  const checked = await requireTaskMembership(req.params.taskId, req.userId);
  if ('error' in checked) {
    return checked.error === 404
      ? sendError(res, 404, 'Task tidak ditemukan')
      : checked.error === 401
        ? sendError(res, 401, 'Tidak terautentikasi')
        : sendError(res, 403, 'Bukan anggota tim ini');
  }
  const attachment = await prisma.attachment.create({
    data: { taskId: req.params.taskId, ...body },
  });
  if (req.userId) {
    await prisma.taskActivity.create({
      data: {
        taskId: req.params.taskId,
        actorId: req.userId,
        kind: 'ATTACHMENT_ADDED',
        meta: {
          filename: body.filename,
          mimeType: body.mimeType,
          size: body.size,
          attachmentId: attachment.id,
        },
      },
    });
  }
  return res.status(201).json({ success: true, data: attachment });
}

const updateAttachmentSchema = z.object({ description: z.string().max(280).nullable() });

// Caption pendek per file — semua anggota tim boleh mengisi.
export async function updateAttachment(req: Request, res: Response) {
  const body = updateAttachmentSchema.parse(req.body);
  const attachment = await prisma.attachment.findUnique({
    where: { id: req.params.attachmentId },
    include: { task: { select: { id: true, project: { select: { teamId: true } } } } },
  });
  if (!attachment || attachment.task.id !== req.params.taskId) {
    return sendError(res, 404, 'Lampiran tidak ditemukan');
  }
  if (!req.userId) return sendError(res, 401, 'Tidak terautentikasi');
  const membership = await prisma.teamMember.findFirst({
    where: { teamId: attachment.task.project.teamId, userId: req.userId },
  });
  if (!membership) return sendError(res, 403, 'Bukan anggota tim ini');
  const updated = await prisma.attachment.update({
    where: { id: req.params.attachmentId },
    data: { description: body.description?.trim() || null },
  });
  return res.json({ success: true, data: updated });
}

export async function removeAttachment(req: Request, res: Response) {
  const attachment = await prisma.attachment.findUnique({
    where: { id: req.params.attachmentId },
    include: { task: { select: { project: { select: { teamId: true } } } } },
  });
  if (!attachment) return sendError(res, 404, 'Lampiran tidak ditemukan');
  if (!req.userId) return sendError(res, 401, 'Tidak terautentikasi');
  const membership = await prisma.teamMember.findFirst({
    where: { teamId: attachment.task.project.teamId, userId: req.userId },
  });
  if (!membership) return sendError(res, 403, 'Bukan anggota tim ini');
  await prisma.attachment.delete({ where: { id: req.params.attachmentId } });
  return res.json({ success: true, data: { id: req.params.attachmentId } });
}

const watcherSchema = z.object({ userId: z.string().min(1).optional() });

// Semua anggota tim boleh memantau task; target harus anggota tim yang sama.
export async function addWatcher(req: Request, res: Response) {
  const body = watcherSchema.parse(req.body);
  const checked = await requireTaskMembership(req.params.taskId, req.userId);
  if ('error' in checked) {
    return checked.error === 404
      ? sendError(res, 404, 'Task tidak ditemukan')
      : checked.error === 401
        ? sendError(res, 401, 'Tidak terautentikasi')
        : sendError(res, 403, 'Bukan anggota tim ini');
  }
  const targetId = body.userId ?? req.userId!;
  const member = await prisma.teamMember.findFirst({
    where: { teamId: checked.membership.teamId, userId: targetId },
  });
  if (!member) return sendError(res, 422, 'Pengguna bukan anggota tim ini');
  const watcher = await prisma.taskWatcher.upsert({
    where: { taskId_userId: { taskId: req.params.taskId, userId: targetId } },
    update: {},
    create: { taskId: req.params.taskId, userId: targetId },
    include: { user: { select: { id: true, name: true, avatarUrl: true } } },
  });
  return res.status(201).json({ success: true, data: watcher.user });
}

export async function removeWatcher(req: Request, res: Response) {
  const checked = await requireTaskMembership(req.params.taskId, req.userId);
  if ('error' in checked) {
    return checked.error === 404
      ? sendError(res, 404, 'Task tidak ditemukan')
      : checked.error === 401
        ? sendError(res, 401, 'Tidak terautentikasi')
        : sendError(res, 403, 'Bukan anggota tim ini');
  }
  await prisma.taskWatcher.deleteMany({
    where: { taskId: req.params.taskId, userId: req.params.userId },
  });
  return res.json({ success: true, data: { userId: req.params.userId } });
}

// Setujui/tolak usulan task — khusus admin tim.
async function decideApproval(req: Request, res: Response, approval: 'APPROVED' | 'REJECTED') {
  const checked = await requireTaskMembership(req.params.taskId, req.userId);
  if ('error' in checked) {
    return checked.error === 404
      ? sendError(res, 404, 'Task tidak ditemukan')
      : checked.error === 401
        ? sendError(res, 401, 'Tidak terautentikasi')
        : sendError(res, 403, 'Bukan anggota tim ini');
  }
  if (checked.membership.role !== 'ADMIN') return sendError(res, 403, 'Hanya admin tim yang bisa menyetujui task');
  const task = await prisma.task.update({
    where: { id: req.params.taskId },
    data: { approval },
    include: {
      ...assigneesInclude,
      ...watchersInclude,
      ...createdBySelect,
      ...columnSelect,
      attachments: { orderBy: { createdAt: 'asc' } },
    },
  });
  // Beri tahu assignee saat usulannya disetujui/ditolak.
  const targets = [...new Set(task.assignees.map((a) => a.user.id))].filter((id) => id !== req.userId);
  if (targets.length > 0) {
    await prisma.notification.createMany({
      data: targets.map((userId) => ({
        userId,
        type: 'TASK_UPDATED' as const,
        title: approval === 'APPROVED' ? 'Task disetujui' : 'Task ditolak',
        message: `Task "${task.title}" ${approval === 'APPROVED' ? 'disetujui admin' : 'ditolak admin'}.`,
        relatedTaskId: task.id,
      })),
    });
  }
  return res.json({ success: true, data: withWatchers(withAssignees(task)) });
}

export async function approveTask(req: Request, res: Response) {
  return decideApproval(req, res, 'APPROVED');
}

export async function rejectTask(req: Request, res: Response) {
  return decideApproval(req, res, 'REJECTED');
}
