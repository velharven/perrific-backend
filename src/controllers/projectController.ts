import type { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { sendError } from '../lib/errors';
import { AVATAR_RE, avatarUrlField } from '../lib/avatar';
import { assigneesInclude, columnSelect, createdBySelect, uniqIds, watchersInclude, withAssignees, withWatchers } from '../lib/taskAssignees';
import { emitToUser } from '../lib/socket';
import { can, ensureProjectMember, PERMISSIONS } from '../lib/permissions';
import type { PermissionKey } from '../lib/permissions';

function isUniqueConflict(e: unknown) {
  return (e as { code?: string })?.code === 'P2002';
}

export async function getProject(req: Request, res: Response) {
  const project = await prisma.project.findUnique({
    where: { id: req.params.projectId },
    include: { team: true },
  });
  if (!project) return sendError(res, 404, 'Proyek tidak ditemukan');
  return res.json({ success: true, data: project });
}

async function requireMembership(projectId: string, userId?: string) {
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) return { error: 404 as const };
  if (!userId) return { error: 401 as const };
  const membership = await prisma.teamMember.findFirst({
    where: { teamId: project.teamId, userId },
  });
  if (!membership) return { error: 403 as const };
  return { project, membership };
}

const updateProjectSchema = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  description: z.string().max(500).nullable().optional(),
  avatarUrl: avatarUrlField,
  status: z.enum(['ACTIVE', 'ARCHIVED']).optional(),
});

export async function updateProject(req: Request, res: Response) {
  const body = updateProjectSchema.parse(req.body);
  if (body.avatarUrl !== undefined && body.avatarUrl !== null && !AVATAR_RE.test(body.avatarUrl)) {
    return sendError(res, 422, 'URL avatar tidak valid');
  }
  const checked = await requireMembership(req.params.projectId, req.userId);
  if ('error' in checked) {
    return checked.error === 404
      ? sendError(res, 404, 'Proyek tidak ditemukan')
      : checked.error === 401
        ? sendError(res, 401, 'Tidak terautentikasi')
        : sendError(res, 403, 'Bukan anggota tim ini');
  }
  if (checked.membership.role !== 'ADMIN' && !(await can(req.userId, req.params.projectId, 'project.manage'))) {
    return sendError(res, 403, 'Hanya admin tim yang bisa mengelola project');
  }
  const project = await prisma.project.update({
    where: { id: req.params.projectId },
    data: { ...body },
  });
  return res.json({ success: true, data: project });
}

export async function deleteProject(req: Request, res: Response) {
  const checked = await requireMembership(req.params.projectId, req.userId);
  if ('error' in checked) {
    return checked.error === 404
      ? sendError(res, 404, 'Proyek tidak ditemukan')
      : checked.error === 401
        ? sendError(res, 401, 'Tidak terautentikasi')
        : sendError(res, 403, 'Bukan anggota tim ini');
  }
  if (checked.membership.role !== 'ADMIN' && !(await can(req.userId, req.params.projectId, 'project.manage'))) {
    return sendError(res, 403, 'Hanya admin tim yang bisa menghapus');
  }
  await prisma.project.delete({ where: { id: req.params.projectId } });
  return res.json({ success: true, data: { id: req.params.projectId } });
}

export async function listTasks(req: Request, res: Response) {
  const tasks = await prisma.task.findMany({
    where: { projectId: req.params.projectId },
    orderBy: [{ column: { order: 'asc' } }, { order: 'asc' }],
    include: { ...assigneesInclude, ...watchersInclude, ...createdBySelect, ...columnSelect },
  });
  return res.json({ success: true, data: tasks.map((t) => withWatchers(withAssignees(t))) });
}

export async function listAttachments(req: Request, res: Response) {
  const attachments = await prisma.attachment.findMany({
    where: { task: { projectId: req.params.projectId } },
    orderBy: { createdAt: 'desc' },
  });
  return res.json({ success: true, data: attachments });
}

// Sekali panggil untuk feed Overview (hindari N+1 per task).
export async function listAllComments(req: Request, res: Response) {
  const comments = await prisma.comment.findMany({
    where: { task: { projectId: req.params.projectId } },
    orderBy: { createdAt: 'asc' },
    include: {
      author: { select: { id: true, name: true, avatarUrl: true } },
      task: { select: { id: true, title: true } },
    },
  });
  return res.json({ success: true, data: comments });
}

export async function listAllActivities(req: Request, res: Response) {
  const items = await prisma.taskActivity.findMany({
    where: { task: { projectId: req.params.projectId } },
    orderBy: { createdAt: 'desc' },
    include: {
      actor: { select: { id: true, name: true, avatarUrl: true } },
      targetUser: { select: { id: true, name: true, avatarUrl: true } },
      task: { select: { id: true, title: true } },
    },
  });
  return res.json({ success: true, data: items });
}

const reorderTasksSchema = z.object({
  columnId: z.string().min(1),
  orderedIds: z.array(z.string()).min(1),
});

// Simpan urutan drag-and-drop se-kolom (anggota tim boleh, seperti geser card).
export async function reorderTasks(req: Request, res: Response) {
  const body = reorderTasksSchema.parse(req.body);
  const checked = await requireMembership(req.params.projectId, req.userId);
  if ('error' in checked) {
    return checked.error === 404
      ? sendError(res, 404, 'Proyek tidak ditemukan')
      : checked.error === 401
        ? sendError(res, 401, 'Tidak terautentikasi')
        : sendError(res, 403, 'Bukan anggota tim ini');
  }
  const column = await prisma.boardColumn.findFirst({
    where: { id: body.columnId, projectId: req.params.projectId },
  });
  if (!column) return sendError(res, 422, 'Kolom tidak valid');
  const count = await prisma.task.count({
    where: { id: { in: body.orderedIds }, projectId: req.params.projectId, columnId: body.columnId },
  });
  if (count !== body.orderedIds.length) return sendError(res, 422, 'Daftar task tidak valid');
  await prisma.$transaction(
    body.orderedIds.map((id, idx) => prisma.task.update({ where: { id }, data: { order: idx } })),
  );
  return res.json({ success: true, data: { orderedIds: body.orderedIds } });
}

const createTaskSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  assigneeIds: z.array(z.string()).optional(),
  priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).default('MEDIUM'),
  columnId: z.string().min(1).optional(),
  dueDate: z.string().datetime().optional(),
});

export async function createTask(req: Request, res: Response) {
  const body = createTaskSchema.parse(req.body);
  const checked = await requireMembership(req.params.projectId, req.userId);
  if ('error' in checked) {
    return checked.error === 404
      ? sendError(res, 404, 'Proyek tidak ditemukan')
      : checked.error === 401
        ? sendError(res, 401, 'Tidak terautentikasi')
        : sendError(res, 403, 'Bukan anggota tim ini');
  }

  // Anggota boleh mengusul; langsung APPROVED bila punya izin approve.
  const approval =
    checked.membership.role === 'ADMIN' || (await can(req.userId, req.params.projectId, 'task.approve'))
      ? 'APPROVED'
      : 'PENDING';

  // Kolom tujuan: yang diminta (harus se-project) atau kolom pertama.
  let columnId = body.columnId ?? null;
  if (columnId) {
    const col = await prisma.boardColumn.findFirst({
      where: { id: columnId, projectId: req.params.projectId },
    });
    if (!col) return sendError(res, 422, 'Kolom tidak valid');
  } else {
    const first = await prisma.boardColumn.findFirst({
      where: { projectId: req.params.projectId },
      orderBy: { order: 'asc' },
    });
    if (!first) return sendError(res, 422, 'Project belum punya kolom kanban');
    columnId = first.id;
  }

  // Nomor urut per project (max + 1 dalam transaksi).
  const task = await prisma.$transaction(async (tx) => {
    const last = await tx.task.findFirst({
      where: { projectId: req.params.projectId },
      orderBy: { number: 'desc' },
      select: { number: true },
    });
    return tx.task.create({
      data: {
        projectId: req.params.projectId,
        columnId,
        number: (last?.number ?? 0) + 1,
        title: body.title,
        description: body.description,
        assignees: { create: uniqIds(body.assigneeIds).map((userId) => ({ userId })) },
        priority: body.priority,
        dueDate: body.dueDate ? new Date(body.dueDate) : null,
        approval,
        createdById: req.userId ?? null,
      },
      include: { ...assigneesInclude, ...createdBySelect, ...columnSelect },
    });
  });
  // Catat penerima awal untuk tab Activities.
  const initialIds = uniqIds(body.assigneeIds);
  if (initialIds.length > 0 && req.userId) {
    await prisma.taskActivity.createMany({
      data: initialIds.map((userId) => ({
        taskId: task.id,
        actorId: req.userId!,
        kind: 'ASSIGNED' as const,
        targetUserId: userId,
      })),
    });
  }

  // Beri tahu socket realtime untuk seluruh penerima tugas (assignees)
  if (approval === 'APPROVED' && initialIds.length > 0) {
    for (const userId of initialIds) {
      emitToUser(userId, 'task:assigned', { taskId: task.id, action: 'ASSIGNED' });
    }
  }
  // Usulan anggota: beri tahu semua yang bisa approve di project ini.
  if (approval === 'PENDING' && req.userId) {
    const proposer = await prisma.user.findUnique({
      where: { id: req.userId },
      select: { name: true },
    });
    const teamAdmins = await prisma.teamMember.findMany({
      where: { teamId: checked.project.teamId, role: 'ADMIN' },
      select: { userId: true },
    });
    const roleApprovers = await prisma.projectMember.findMany({
      where: { projectId: req.params.projectId },
      select: { userId: true, role: { select: { permissions: true } } },
    });
    const targets = [
      ...new Set([
        ...teamAdmins.map((a) => a.userId),
        ...roleApprovers.filter((m) => m.role.permissions.includes('task.approve')).map((m) => m.userId),
      ]),
    ].filter((id) => id !== req.userId);
    if (targets.length > 0) {
      await prisma.notification.createMany({
        data: targets.map((userId) => ({
          userId,
          type: 'SYSTEM' as const,
          title: 'Usulan task baru',
          message: `${proposer?.name ?? 'Anggota tim'} mengusulkan task "${body.title}" dan perlu persetujuan.`,
          relatedTaskId: task.id,
        })),
      });
    }
  }
  return res.status(201).json({ success: true, data: withAssignees(task) });
}

// ===== Kolom kanban bebas (F-04 ala Taiga) =====

async function requirePerm(projectId: string, userId: string | undefined, perm: PermissionKey) {
  const checked = await requireMembership(projectId, userId);
  if ('error' in checked) return checked;
  if (checked.membership.role === 'ADMIN') return checked;
  if (await can(userId, projectId, perm)) return checked;
  return { error: 403 as const, admin: true as const };
}

function adminError(res: Response, checked: { error?: number; admin?: boolean }) {
  if (checked.admin) return sendError(res, 403, 'Hanya admin tim yang bisa mengatur kolom board');
  return checked.error === 404
    ? sendError(res, 404, 'Proyek tidak ditemukan')
    : checked.error === 401
      ? sendError(res, 401, 'Tidak terautentikasi')
      : sendError(res, 403, 'Bukan anggota tim ini');
}

export async function listColumns(req: Request, res: Response) {
  const checked = await requireMembership(req.params.projectId, req.userId);
  if ('error' in checked) {
    return checked.error === 404
      ? sendError(res, 404, 'Proyek tidak ditemukan')
      : checked.error === 401
        ? sendError(res, 401, 'Tidak terautentikasi')
        : sendError(res, 403, 'Bukan anggota tim ini');
  }
  const columns = await prisma.boardColumn.findMany({
    where: { projectId: req.params.projectId },
    orderBy: { order: 'asc' },
  });
  return res.json({ success: true, data: columns });
}

const createColumnSchema = z.object({ name: z.string().trim().min(1).max(30) });

export async function createColumn(req: Request, res: Response) {
  const body = createColumnSchema.parse(req.body);
  const checked = await requirePerm(req.params.projectId, req.userId, 'column.manage');
  if ('error' in checked) return adminError(res, checked);
  const last = await prisma.boardColumn.findFirst({
    where: { projectId: req.params.projectId },
    orderBy: { order: 'desc' },
  });
  const column = await prisma.boardColumn.create({
    data: { projectId: req.params.projectId, name: body.name, order: (last?.order ?? -1) + 1 },
  });
  return res.status(201).json({ success: true, data: column });
}

const updateColumnSchema = z
  .object({
    name: z.string().trim().min(1).max(30).optional(),
    color: z
      .string()
      .trim()
      .regex(/^#[0-9a-fA-F]{6}$/, 'Warna tidak valid')
      .optional(),
  })
  .refine((v) => v.name !== undefined || v.color !== undefined, 'Tidak ada perubahan');

export async function updateColumn(req: Request, res: Response) {
  const body = updateColumnSchema.parse(req.body);
  const checked = await requirePerm(req.params.projectId, req.userId, 'column.manage');
  if ('error' in checked) return adminError(res, checked);
  const column = await prisma.boardColumn
    .update({ where: { id: req.params.columnId }, data: { ...body } })
    .catch(() => null);
  if (!column || column.projectId !== req.params.projectId) {
    return sendError(res, 404, 'Kolom tidak ditemukan');
  }
  return res.json({ success: true, data: column });
}

const reorderColumnsSchema = z.object({ orderedIds: z.array(z.string()).min(1) });

export async function reorderColumns(req: Request, res: Response) {
  const body = reorderColumnsSchema.parse(req.body);
  const checked = await requirePerm(req.params.projectId, req.userId, 'column.manage');
  if ('error' in checked) return adminError(res, checked);
  const count = await prisma.boardColumn.count({
    where: { id: { in: body.orderedIds }, projectId: req.params.projectId },
  });
  if (count !== body.orderedIds.length) return sendError(res, 422, 'Daftar kolom tidak valid');
  await prisma.$transaction(
    body.orderedIds.map((id, idx) => prisma.boardColumn.update({ where: { id }, data: { order: idx } })),
  );
  return res.json({ success: true, data: { orderedIds: body.orderedIds } });
}

const deleteColumnSchema = z.object({ targetColumnId: z.string().min(1).optional() });

export async function deleteColumn(req: Request, res: Response) {
  const body = deleteColumnSchema.parse(req.body);
  const checked = await requirePerm(req.params.projectId, req.userId, 'column.manage');
  if ('error' in checked) return adminError(res, checked);
  const column = await prisma.boardColumn.findFirst({
    where: { id: req.params.columnId, projectId: req.params.projectId },
  });
  if (!column) return sendError(res, 404, 'Kolom tidak ditemukan');
  const total = await prisma.boardColumn.count({ where: { projectId: req.params.projectId } });
  if (total <= 1) return sendError(res, 422, 'Project harus punya minimal 1 kolom');
  const taskCount = await prisma.task.count({ where: { columnId: column.id } });
  if (taskCount > 0) {
    // Kolom berisi: wajib pilih kolom tujuan lewat popup di frontend.
    if (!body.targetColumnId || body.targetColumnId === column.id) {
      return sendError(res, 422, `Kolom berisi ${taskCount} task. Pilih kolom tujuan untuk memindahkannya.`);
    }
    const target = await prisma.boardColumn.findFirst({
      where: { id: body.targetColumnId, projectId: req.params.projectId },
    });
    if (!target) return sendError(res, 422, 'Kolom tujuan tidak valid');
    const lastOrder = await prisma.task.findFirst({
      where: { columnId: target.id },
      orderBy: { order: 'desc' },
      select: { order: true },
    });
    const base = (lastOrder?.order ?? -1) + 1;
    const moving = await prisma.task.findMany({
      where: { columnId: column.id },
      orderBy: { order: 'asc' },
      select: { id: true },
    });
    await prisma.$transaction([
      ...moving.map((t, idx) =>
        prisma.task.update({ where: { id: t.id }, data: { columnId: target.id, order: base + idx } }),
      ),
      prisma.boardColumn.delete({ where: { id: column.id } }),
    ]);
    return res.json({ success: true, data: { id: column.id, movedCount: moving.length } });
  }
  await prisma.boardColumn.delete({ where: { id: column.id } });
  return res.json({ success: true, data: { id: column.id, movedCount: 0 } });
}

// ===== Role custom per project =====

async function requireRoleManage(projectId: string, userId: string | undefined) {
  const checked = await requireMembership(projectId, userId);
  if ('error' in checked) return checked;
  if (checked.membership.role === 'ADMIN') return checked;
  if (await can(userId, projectId, 'role.manage')) return checked;
  return { error: 403 as const, admin: true as const };
}

function roleError(res: Response, checked: { error?: number; admin?: boolean }) {
  if (checked.admin) return sendError(res, 403, 'Hanya yang berhak mengelola role yang bisa mengatur role');
  return checked.error === 404
    ? sendError(res, 404, 'Proyek tidak ditemukan')
    : checked.error === 401
      ? sendError(res, 401, 'Tidak terautentikasi')
      : sendError(res, 403, 'Bukan anggota tim ini');
}

export async function listRoles(req: Request, res: Response) {
  const checked = await requireMembership(req.params.projectId, req.userId);
  if ('error' in checked) {
    return checked.error === 404
      ? sendError(res, 404, 'Proyek tidak ditemukan')
      : checked.error === 401
        ? sendError(res, 401, 'Tidak terautentikasi')
        : sendError(res, 403, 'Bukan anggota tim ini');
  }
  const roles = await prisma.projectRole.findMany({
    where: { projectId: req.params.projectId },
    orderBy: { createdAt: 'asc' },
    include: { _count: { select: { members: true } } },
  });
  return res.json({ success: true, data: roles });
}

const roleSchema = z.object({
  name: z.string().trim().min(1).max(30),
  permissions: z.array(z.enum(PERMISSIONS)).default([]),
});

export async function createRole(req: Request, res: Response) {
  const body = roleSchema.parse(req.body);
  const checked = await requireRoleManage(req.params.projectId, req.userId);
  if ('error' in checked) return roleError(res, checked);
  try {
    const role = await prisma.projectRole.create({
      data: { projectId: req.params.projectId, name: body.name, permissions: body.permissions },
    });
    return res.status(201).json({ success: true, data: role });
  } catch (e: unknown) {
    if (isUniqueConflict(e)) return sendError(res, 409, 'Nama role sudah dipakai di project ini.');
    throw e;
  }
}

const updateRoleSchema = z.object({
  name: z.string().trim().min(1).max(30).optional(),
  permissions: z.array(z.enum(PERMISSIONS)).optional(),
});

export async function updateRole(req: Request, res: Response) {
  const body = updateRoleSchema.parse(req.body);
  const checked = await requireRoleManage(req.params.projectId, req.userId);
  if ('error' in checked) return roleError(res, checked);
  const existing = await prisma.projectRole.findFirst({
    where: { id: req.params.roleId, projectId: req.params.projectId },
  });
  if (!existing) return sendError(res, 404, 'Role tidak ditemukan');
  if (existing.system) return sendError(res, 422, 'Role bawaan tidak bisa diubah. Buat role baru bila perlu beda.');
  try {
    const role = await prisma.projectRole.update({
      where: { id: existing.id },
      data: { ...body },
    });
    return res.json({ success: true, data: role });
  } catch (e: unknown) {
    if (isUniqueConflict(e)) return sendError(res, 409, 'Nama role sudah dipakai di project ini.');
    throw e;
  }
}

const deleteRoleSchema = z.object({ targetRoleId: z.string().min(1).optional() });

export async function deleteRole(req: Request, res: Response) {
  const body = deleteRoleSchema.parse(req.body);
  const checked = await requireRoleManage(req.params.projectId, req.userId);
  if ('error' in checked) return roleError(res, checked);
  const role = await prisma.projectRole.findFirst({
    where: { id: req.params.roleId, projectId: req.params.projectId },
  });
  if (!role) return sendError(res, 404, 'Role tidak ditemukan');
  if (role.system) return sendError(res, 422, 'Role bawaan tidak bisa dihapus.');
  const assigned = await prisma.projectMember.count({ where: { roleId: role.id } });
  if (assigned > 0) {
    if (!body.targetRoleId || body.targetRoleId === role.id) {
      return sendError(res, 422, `Role dipakai ${assigned} anggota. Pilih role pengganti.`);
    }
    const target = await prisma.projectRole.findFirst({
      where: { id: body.targetRoleId, projectId: req.params.projectId },
    });
    if (!target) return sendError(res, 422, 'Role pengganti tidak valid');
    await prisma.$transaction([
      prisma.projectMember.updateMany({ where: { roleId: role.id }, data: { roleId: target.id } }),
      prisma.projectRole.delete({ where: { id: role.id } }),
    ]);
    return res.json({ success: true, data: { id: role.id, movedCount: assigned } });
  }
  await prisma.projectRole.delete({ where: { id: role.id } });
  return res.json({ success: true, data: { id: role.id, movedCount: 0 } });
}

const memberSelect = { id: true, name: true, email: true, avatarUrl: true } as const;

export async function listProjectMembers(req: Request, res: Response) {
  const checked = await requireMembership(req.params.projectId, req.userId);
  if ('error' in checked) {
    return checked.error === 404
      ? sendError(res, 404, 'Proyek tidak ditemukan')
      : checked.error === 401
        ? sendError(res, 401, 'Tidak terautentikasi')
        : sendError(res, 403, 'Bukan anggota tim ini');
  }
  // Pastikan semua anggota tim punya baris jabatan (malas, idempoten).
  const teamMembers = await prisma.teamMember.findMany({
    where: { teamId: checked.project.teamId },
    select: { userId: true },
  });
  for (const m of teamMembers) {
    await ensureProjectMember(req.params.projectId, m.userId);
  }
  const members = await prisma.projectMember.findMany({
    where: { projectId: req.params.projectId },
    include: { user: { select: memberSelect }, role: true },
    orderBy: { createdAt: 'asc' },
  });
  return res.json({ success: true, data: members });
}

const setMemberRoleSchema = z.object({ roleId: z.string().min(1) });

export async function setMemberRole(req: Request, res: Response) {
  const body = setMemberRoleSchema.parse(req.body);
  const checked = await requireRoleManage(req.params.projectId, req.userId);
  if ('error' in checked) return roleError(res, checked);
  const role = await prisma.projectRole.findFirst({
    where: { id: body.roleId, projectId: req.params.projectId },
  });
  if (!role) return sendError(res, 422, 'Role tidak valid');
  const member = await prisma.projectMember.findFirst({
    where: { projectId: req.params.projectId, userId: req.params.userId },
  });
  if (!member) return sendError(res, 404, 'Anggota tidak ditemukan di project ini');
  const updated = await prisma.projectMember.update({
    where: { id: member.id },
    data: { roleId: role.id },
    include: { user: { select: memberSelect }, role: true },
  });
  return res.json({ success: true, data: updated });
}
