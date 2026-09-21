import type { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { sendError } from '../lib/errors';
import { AVATAR_RE, avatarUrlField } from '../lib/avatar';
import { randomInviteCode } from '../lib/inviteCode';
import { assigneesInclude, columnSelect, createdBySelect, withAssignees } from '../lib/taskAssignees';

const createTeamSchema = z.object({ name: z.string().min(1), description: z.string().optional() });

// Kode unik praktis: cek dulu, bentrok DB (P2002) → coba lagi. Maks 5x,
// lalu fallback yang praktis mustahil tabrakan.
async function createUniqueInviteCode(): Promise<string> {
  for (let i = 0; i < 5; i += 1) {
    const code = randomInviteCode();
    const exists = await prisma.team.findUnique({ where: { inviteCode: code } });
    if (!exists) return code;
  }
  return `${randomInviteCode(10)}${Date.now().toString(36).slice(-2).toUpperCase()}`;
}

function isUniqueConflict(e: unknown) {
  return (e as { code?: string })?.code === 'P2002';
}

export async function listMyTeams(req: Request, res: Response) {
  const teams = await prisma.team.findMany({
    where: { members: { some: { userId: req.userId } } },
    include: { members: { include: { user: { select: { id: true, name: true, avatarUrl: true } } } } },
  });
  // Kode invite + kedaluwarsa hanya untuk admin tim masing-masing.
  return res.json({
    success: true,
    data: teams.map((t) =>
      t.members.some((m) => m.userId === req.userId && m.role === 'ADMIN')
        ? t
        : { ...t, inviteCode: null, inviteExpiresAt: null },
    ),
  });
}

export async function createTeam(req: Request, res: Response) {
  const body = createTeamSchema.parse(req.body);
  if (!req.userId) return sendError(res, 401, 'Tidak terautentikasi');

  const team = await prisma.team.create({
    data: {
      ...body,
      inviteCode: await createUniqueInviteCode(),
      // Kode baru berlaku 7 hari agar tidak ada kode abadi yang bisa ditebak
      // kapan saja; admin bisa ubah/perpanjang dari tab Undang.
      inviteExpiresAt: new Date(Date.now() + 7 * 24 * 3600_000),
      members: { create: { userId: req.userId, role: 'ADMIN' } },
    },
    include: { members: true },
  });
  return res.status(201).json({ success: true, data: team });
}

export async function getTeam(req: Request, res: Response) {
  const team = await prisma.team.findUnique({
    where: { id: req.params.teamId },
    include: { members: { include: { user: { select: { id: true, name: true, email: true, avatarUrl: true } } } } },
  });
  if (!team) return sendError(res, 404, 'Tim tidak ditemukan');
  // Kode invite hanya untuk admin tim ini (anggota biasa tak perlu tahu).
  if (req.userId) {
    const membership = await prisma.teamMember.findUnique({
      where: { userId_teamId: { userId: req.userId, teamId: team.id } },
    });
    if (membership?.role === 'ADMIN') return res.json({ success: true, data: team });
  }
  return res.json({ success: true, data: { ...team, inviteCode: null, inviteExpiresAt: null } });
}

const updateTeamSchema = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  description: z.string().max(500).nullable().optional(),
});

export async function updateTeam(req: Request, res: Response) {
  const body = updateTeamSchema.parse(req.body);
  if (!req.userId) return sendError(res, 401, 'Tidak terautentikasi');
  const teamId = req.params.teamId;
  const membership = await prisma.teamMember.findFirst({
    where: { teamId, userId: req.userId },
  });
  if (!membership) return sendError(res, 403, 'Bukan anggota tim ini');
  const team = await prisma.team
    .update({ where: { id: teamId }, data: { ...body } })
    .catch(() => null);
  if (!team) return sendError(res, 404, 'Tim tidak ditemukan');
  return res.json({ success: true, data: team });
}

export async function deleteTeam(req: Request, res: Response) {
  if (!req.userId) return sendError(res, 401, 'Tidak terautentikasi');
  const teamId = req.params.teamId;
  const membership = await prisma.teamMember.findFirst({
    where: { teamId, userId: req.userId },
  });
  if (!membership) return sendError(res, 403, 'Bukan anggota tim ini');
  if (membership.role !== 'ADMIN') return sendError(res, 403, 'Hanya admin tim yang bisa menghapus');
  await prisma.team.delete({ where: { id: teamId } }).catch(() => null);
  return res.json({ success: true, data: { id: teamId } });
}

const joinTeamSchema = z.object({
  code: z
    .string()
    .trim()
    .min(4)
    .max(16)
    .transform((s) => s.replace(/\s+/g, '').toUpperCase()),
});

// Masuk tim pakai kode invite: membuat permintaan PENDING yang disetujui admin
// (tab Persetujuan). Email langsung oleh admin tetap tanpa antre.
export async function joinTeam(req: Request, res: Response) {
  const { code } = joinTeamSchema.parse(req.body);
  if (!req.userId) return sendError(res, 401, 'Tidak terautentikasi');
  const team = await prisma.team.findUnique({ where: { inviteCode: code } });
  if (!team) return sendError(res, 404, 'Kode tim tidak ditemukan. Periksa lagi kodenya.');
  if (team.inviteExpiresAt && team.inviteExpiresAt.getTime() <= Date.now()) {
    return sendError(res, 410, 'Kode tim sudah kedaluwarsa. Minta kode baru ke admin tim.');
  }
  const existing = await prisma.teamMember.findUnique({
    where: { userId_teamId: { userId: req.userId, teamId: team.id } },
  });
  if (existing) return sendError(res, 409, 'Kamu sudah anggota tim ini.');
  const pending = await prisma.teamJoinRequest.findFirst({
    where: { teamId: team.id, userId: req.userId, status: 'PENDING' },
  });
  if (pending) return sendError(res, 409, 'Permintaan bergabungmu masih menunggu persetujuan admin.');
  const request = await prisma.teamJoinRequest.create({
    data: { teamId: team.id, userId: req.userId },
    include: {
      team: { select: { id: true, name: true } },
      user: { select: { id: true, name: true, email: true, avatarUrl: true } },
    },
  });
  // Beri tahu semua admin tim agar segera direview.
  const admins = await prisma.teamMember.findMany({
    where: { teamId: team.id, role: 'ADMIN' },
    select: { userId: true },
  });
  const targets = [...new Set(admins.map((a) => a.userId))].filter((id) => id !== req.userId);
  if (targets.length > 0) {
    await prisma.notification.createMany({
      data: targets.map((userId) => ({
        userId,
        type: 'TEAM_INVITE' as const,
        title: 'Permintaan bergabung baru',
        message: `${request.user.name} meminta bergabung ke tim "${team.name}".`,
      })),
    });
  }
  return res.status(201).json({ success: true, data: request });
}

const updateInviteSchema = z.object({
  expiresInHours: z.number().min(0).max(24 * 365).nullable(),
  regenerate: z.boolean().optional(),
});

// Atur kedaluwarsa invite + putar kode baru (ADMIN saja).
export async function updateInvite(req: Request, res: Response) {
  const body = updateInviteSchema.parse(req.body);
  if (!req.userId) return sendError(res, 401, 'Tidak terautentikasi');
  const teamId = req.params.teamId;
  const membership = await prisma.teamMember.findFirst({
    where: { teamId, userId: req.userId },
  });
  if (!membership) return sendError(res, 403, 'Bukan anggota tim ini');
  if (membership.role !== 'ADMIN') return sendError(res, 403, 'Hanya admin tim yang bisa mengatur invite');
  const team = await prisma.team.update({
    where: { id: teamId },
    data: {
      inviteExpiresAt: body.expiresInHours === null ? null : new Date(Date.now() + body.expiresInHours * 3600_000),
      ...(body.regenerate ? { inviteCode: await createUniqueInviteCode() } : {}),
    },
    include: { members: { include: { user: { select: { id: true, name: true, email: true, avatarUrl: true } } } } },
  }).catch(() => null);
  if (!team) return sendError(res, 404, 'Tim tidak ditemukan');
  return res.json({ success: true, data: team });
}

const joinRequestUserSelect = { id: true, name: true, email: true, avatarUrl: true } as const;

const joinRequestInclude = {
  user: { select: joinRequestUserSelect },
  team: { select: { id: true, name: true } },
} as const;

// Daftar permintaan bergabung (default PENDING) — khusus ADMIN.
export async function listJoinRequests(req: Request, res: Response) {
  if (!req.userId) return sendError(res, 401, 'Tidak terautentikasi');
  const teamId = req.params.teamId;
  const membership = await prisma.teamMember.findFirst({ where: { teamId, userId: req.userId } });
  if (!membership) return sendError(res, 403, 'Bukan anggota tim ini');
  if (membership.role !== 'ADMIN') return sendError(res, 403, 'Hanya admin tim yang bisa melihat permintaan bergabung');
  const raw = String(req.query.status ?? 'PENDING').toUpperCase();
  const status = raw === 'APPROVED' || raw === 'REJECTED' ? raw : 'PENDING';
  const items = await prisma.teamJoinRequest.findMany({
    where: { teamId, status: status as 'PENDING' | 'APPROVED' | 'REJECTED' },
    orderBy: { createdAt: 'asc' },
    include: joinRequestInclude,
  });
  return res.json({ success: true, data: items });
}

// Setujui/tolak permintaan bergabung — khusus ADMIN.
async function decideJoinRequest(req: Request, res: Response, status: 'APPROVED' | 'REJECTED') {
  if (!req.userId) return sendError(res, 401, 'Tidak terautentikasi');
  const { teamId, requestId } = req.params;
  const membership = await prisma.teamMember.findFirst({ where: { teamId, userId: req.userId } });
  if (!membership) return sendError(res, 403, 'Bukan anggota tim ini');
  if (membership.role !== 'ADMIN') return sendError(res, 403, 'Hanya admin tim yang bisa menyetujui anggota');
  const jr = await prisma.teamJoinRequest.findUnique({
    where: { id: requestId },
    include: { team: { select: { id: true, name: true } }, user: { select: joinRequestUserSelect } },
  });
  if (!jr || jr.teamId !== teamId) return sendError(res, 404, 'Permintaan tidak ditemukan');
  if (jr.status !== 'PENDING') return sendError(res, 409, 'Permintaan ini sudah diputuskan.');
  if (status === 'APPROVED') {
    try {
      await prisma.teamMember.create({ data: { teamId, userId: jr.userId, role: 'MEMBER' } });
    } catch (e: unknown) {
      // Balapan dua admin menyetujui bersamaan: anggap sudah anggota.
      if (!isUniqueConflict(e)) throw e;
    }
  }
  const updated = await prisma.teamJoinRequest.update({
    where: { id: jr.id },
    data: { status, decidedAt: new Date(), decidedById: req.userId },
    include: joinRequestInclude,
  });
  await prisma.notification.create({
    data: {
      userId: jr.userId,
      type: 'TEAM_INVITE',
      title: status === 'APPROVED' ? 'Bergabung disetujui' : 'Bergabung ditolak',
      message:
        status === 'APPROVED'
          ? `Permintaanmu bergabung ke tim "${jr.team.name}" disetujui. Selamat datang!`
          : `Permintaanmu bergabung ke tim "${jr.team.name}" ditolak admin.`,
    },
  });
  return res.json({ success: true, data: updated });
}

export async function approveJoinRequest(req: Request, res: Response) {
  return decideJoinRequest(req, res, 'APPROVED');
}

export async function rejectJoinRequest(req: Request, res: Response) {
  return decideJoinRequest(req, res, 'REJECTED');
}

// Daftar task PENDING se-tim untuk tab Persetujuan — khusus ADMIN.
export async function listPendingTasks(req: Request, res: Response) {
  if (!req.userId) return sendError(res, 401, 'Tidak terautentikasi');
  const teamId = req.params.teamId;
  const membership = await prisma.teamMember.findFirst({ where: { teamId, userId: req.userId } });
  if (!membership) return sendError(res, 403, 'Bukan anggota tim ini');
  if (membership.role !== 'ADMIN') return sendError(res, 403, 'Hanya admin tim yang bisa melihat persetujuan task');
  const tasks = await prisma.task.findMany({
    where: { project: { teamId }, approval: 'PENDING' },
    orderBy: { createdAt: 'asc' },
    include: {
      ...assigneesInclude,
      ...createdBySelect,
      ...columnSelect,
      project: { select: { id: true, name: true } },
    },
  });
  return res.json({ success: true, data: tasks.map((t) => withAssignees(t)) });
}

const addMemberSchema = z.object({ email: z.string().email(), role: z.enum(['ADMIN', 'MEMBER']).default('MEMBER') });
export async function addMember(req: Request, res: Response) {
  const body = addMemberSchema.parse(req.body);
  const teamId = req.params.teamId;
  const user = await prisma.user.findUnique({ where: { email: body.email } });
  if (!user) return sendError(res, 404, 'Pengguna tidak ditemukan');

  const member = await prisma.teamMember.create({
    data: { teamId, userId: user.id, role: body.role },
  });
  return res.status(201).json({ success: true, data: member });
}

export async function removeMember(req: Request, res: Response) {
  if (!req.userId) return sendError(res, 401, 'Tidak terautentikasi');
  const { teamId, userId } = req.params;
  const mine = await prisma.teamMember.findFirst({ where: { teamId, userId: req.userId } });
  if (!mine) return sendError(res, 403, 'Bukan anggota tim ini');
  if (mine.role !== 'ADMIN') return sendError(res, 403, 'Hanya admin tim yang bisa mengeluarkan anggota');
  if (userId === req.userId) return sendError(res, 422, 'Tidak bisa mengeluarkan diri sendiri');
  const target = await prisma.teamMember.findFirst({ where: { teamId, userId } });
  if (!target) return sendError(res, 404, 'Anggota tidak ditemukan');
  if (target.role === 'ADMIN') {
    const adminCount = await prisma.teamMember.count({ where: { teamId, role: 'ADMIN' } });
    if (adminCount <= 1) return sendError(res, 422, 'Tidak bisa mengeluarkan satu-satunya admin');
  }
  await prisma.teamMember.delete({ where: { id: target.id } });
  return res.json({ success: true, data: { userId } });
}

export async function listMembers(req: Request, res: Response) {
  const members = await prisma.teamMember.findMany({
    where: { teamId: req.params.teamId },
    include: { user: { select: { id: true, name: true, email: true, avatarUrl: true } } },
  });
  return res.json({ success: true, data: members });
}

export async function listProjects(req: Request, res: Response) {
  if (!req.userId) return sendError(res, 401, 'Tidak terautentikasi');
  const teamId = req.params.teamId;
  const membership = await prisma.teamMember.findFirst({
    where: { teamId, userId: req.userId },
  });
  if (!membership) return sendError(res, 403, 'Bukan anggota tim ini');
  const projects = await prisma.project.findMany({
    where: { teamId },
    orderBy: { createdAt: 'asc' },
  });
  return res.json({ success: true, data: projects });
}

const createProjectSchema = z.object({
  name: z.string().trim().min(1).max(60),
  description: z.string().max(500).optional(),
  avatarUrl: avatarUrlField,
});

export async function createProject(req: Request, res: Response) {
  const body = createProjectSchema.parse(req.body);
  if (!req.userId) return sendError(res, 401, 'Tidak terautentikasi');
  const teamId = req.params.teamId;
  const membership = await prisma.teamMember.findFirst({
    where: { teamId, userId: req.userId },
  });
  if (!membership) return sendError(res, 403, 'Bukan anggota tim ini');
  if (membership.role !== 'ADMIN') return sendError(res, 403, 'Hanya admin tim yang bisa mengelola project');
  if (body.avatarUrl !== undefined && body.avatarUrl !== null && !AVATAR_RE.test(body.avatarUrl)) {
    return sendError(res, 422, 'URL avatar tidak valid');
  }
  const project = await prisma.project.create({
    data: {
      teamId,
      name: body.name,
      description: body.description,
      avatarUrl: body.avatarUrl ?? undefined,
      columns: {
        create: [
          { name: 'To Do', color: '#8A8F98', order: 0 },
          { name: 'In Progress', color: '#0090FF', order: 1 },
          { name: 'Done', color: '#46A758', order: 2 },
        ],
      },
    },
  });
  return res.status(201).json({ success: true, data: project });
}
