import type { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { sendError } from '../lib/errors';
import { emitToUser } from '../lib/socket';

const createOrgSchema = z.object({
  name: z.string().trim().min(1, 'Nama organisasi wajib diisi').max(60, 'Nama maksimal 60 karakter'),
  description: z.string().max(500).optional(),
  teamIds: z.array(z.string().min(1)).optional(),
});

const updateOrgSchema = z.object({
  name: z.string().trim().min(1, 'Nama organisasi wajib diisi').max(60).optional(),
  description: z.string().max(500).optional(),
});

const proposeProjectSchema = z.object({
  teamId: z.string().min(1, 'Tim tujuan wajib dipilih'),
  name: z.string().trim().min(1, 'Nama project wajib diisi').max(60),
  description: z.string().max(500).optional(),
});

const sendTaskSchema = z.object({
  projectId: z.string().min(1, 'Project tujuan wajib dipilih'),
  title: z.string().trim().min(1, 'Judul task wajib diisi').max(120),
  description: z.string().max(2000).optional(),
  priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).default('MEDIUM'),
  dueDate: z.string().optional(),
});

const addMemberSchema = z.object({
  email: z.string().email('Format email tidak valid'),
});

// Helper: Cek apakah user adalah anggota organisasi
async function getOrgMembership(orgId: string, userId: string) {
  const membership = await prisma.organizationMember.findUnique({
    where: {
      organizationId_userId: {
        organizationId: orgId,
        userId,
      },
    },
  });
  return membership;
}

export async function listMyOrganizations(req: Request, res: Response) {
  if (!req.userId) return sendError(res, 401, 'Tidak terautentikasi');

  const organizations = await prisma.organization.findMany({
    where: {
      members: { some: { userId: req.userId } },
    },
    include: {
      members: {
        include: {
          user: {
            select: { id: true, name: true, email: true, avatarUrl: true },
          },
        },
      },
      connectedTeams: {
        include: {
          team: {
            select: { id: true, name: true, avatarUrl: true },
          },
        },
      },
      _count: {
        select: {
          projectProposals: true,
          tasks: true,
        },
      },
    },
    orderBy: [{ order: 'asc' }, { createdAt: 'asc' }],
  });

  return res.json({ success: true, data: organizations });
}

export async function createOrganization(req: Request, res: Response) {
  if (!req.userId) return sendError(res, 401, 'Tidak terautentikasi');

  const body = createOrgSchema.parse(req.body);

  const org = await prisma.organization.create({
    data: {
      name: body.name,
      description: body.description,
      createdById: req.userId,
      members: {
        create: {
          userId: req.userId,
          role: 'ADMIN',
        },
      },
      connectedTeams: body.teamIds && body.teamIds.length > 0
        ? {
            create: body.teamIds.map((teamId) => ({ teamId })),
          }
        : undefined,
    },
    include: {
      members: {
        include: {
          user: {
            select: { id: true, name: true, email: true, avatarUrl: true },
          },
        },
      },
      connectedTeams: {
        include: {
          team: {
            select: { id: true, name: true, avatarUrl: true },
          },
        },
      },
    },
  });

  return res.status(201).json({ success: true, data: org });
}

export async function getOrganization(req: Request, res: Response) {
  if (!req.userId) return sendError(res, 401, 'Tidak terautentikasi');
  const { id } = req.params;

  const membership = await getOrgMembership(id, req.userId);
  if (!membership) {
    const orgExists = await prisma.organization.findUnique({ where: { id } });
    if (!orgExists) return sendError(res, 404, 'Organisasi tidak ditemukan');
    return sendError(res, 403, 'Anda bukan anggota organisasi ini');
  }

  const organization = await prisma.organization.findUnique({
    where: { id },
    include: {
      members: {
        include: {
          user: {
            select: { id: true, name: true, email: true, avatarUrl: true },
          },
        },
        orderBy: { joinedAt: 'asc' },
      },
      connectedTeams: {
        include: {
          team: {
            include: {
              projects: {
                where: { status: 'ACTIVE' },
                select: { id: true, name: true, status: true },
                orderBy: { name: 'asc' },
              },
            },
          },
        },
      },
      projectProposals: {
        include: {
          team: { select: { id: true, name: true, avatarUrl: true } },
          createdBy: { select: { id: true, name: true, email: true } },
          approvedProject: { select: { id: true, name: true } },
        },
        orderBy: { createdAt: 'desc' },
      },
      tasks: {
        include: {
          project: {
            include: {
              team: { select: { id: true, name: true } },
            },
          },
          column: { select: { id: true, name: true, color: true } },
          createdBy: { select: { id: true, name: true } },
        },
        orderBy: { createdAt: 'desc' },
      },
    },
  });

  if (!organization) return sendError(res, 404, 'Organisasi tidak ditemukan');
  return res.json({ success: true, data: organization });
}

export async function updateOrganization(req: Request, res: Response) {
  if (!req.userId) return sendError(res, 401, 'Tidak terautentikasi');
  const { id } = req.params;
  const body = updateOrgSchema.parse(req.body);

  const membership = await getOrgMembership(id, req.userId);
  if (!membership || membership.role !== 'ADMIN') {
    return sendError(res, 403, 'Hanya admin organisasi yang dapat mengubah info organisasi');
  }

  const updated = await prisma.organization.update({
    where: { id },
    data: {
      name: body.name,
      description: body.description,
    },
  });

  return res.json({ success: true, data: updated });
}

export async function deleteOrganization(req: Request, res: Response) {
  if (!req.userId) return sendError(res, 401, 'Tidak terautentikasi');
  const { id } = req.params;

  const org = await prisma.organization.findUnique({ where: { id } });
  if (!org) return sendError(res, 404, 'Organisasi tidak ditemukan');

  const membership = await getOrgMembership(id, req.userId);
  if (!membership || (org.createdById !== req.userId && membership.role !== 'ADMIN')) {
    return sendError(res, 403, 'Hanya pembuat atau admin yang dapat menghapus organisasi');
  }

  await prisma.organization.delete({ where: { id } });
  return res.json({ success: true, message: 'Organisasi berhasil dihapus' });
}

export async function connectTeam(req: Request, res: Response) {
  if (!req.userId) return sendError(res, 401, 'Tidak terautentikasi');
  const { id } = req.params;
  const { teamId } = z.object({ teamId: z.string().min(1) }).parse(req.body);

  const membership = await getOrgMembership(id, req.userId);
  if (!membership) return sendError(res, 403, 'Bukan anggota organisasi ini');

  const team = await prisma.team.findUnique({ where: { id: teamId } });
  if (!team) return sendError(res, 404, 'Tim tidak ditemukan');

  const conn = await prisma.organizationTeam.upsert({
    where: {
      organizationId_teamId: {
        organizationId: id,
        teamId,
      },
    },
    create: {
      organizationId: id,
      teamId,
    },
    update: {},
    include: {
      team: true,
    },
  });

  return res.json({ success: true, data: conn });
}

export async function disconnectTeam(req: Request, res: Response) {
  if (!req.userId) return sendError(res, 401, 'Tidak terautentikasi');
  const { id, teamId } = req.params;

  const membership = await getOrgMembership(id, req.userId);
  if (!membership || membership.role !== 'ADMIN') {
    return sendError(res, 403, 'Hanya admin organisasi yang dapat memutuskan hubungan tim');
  }

  await prisma.organizationTeam.deleteMany({
    where: {
      organizationId: id,
      teamId,
    },
  });

  return res.json({ success: true, message: 'Tim berhasil diputuskan dari organisasi' });
}

export async function addMember(req: Request, res: Response) {
  if (!req.userId) return sendError(res, 401, 'Tidak terautentikasi');
  const { id } = req.params;
  const { email } = addMemberSchema.parse(req.body);

  const membership = await getOrgMembership(id, req.userId);
  if (!membership || membership.role !== 'ADMIN') {
    return sendError(res, 403, 'Hanya admin organisasi yang dapat menambah anggota');
  }

  const targetUser = await prisma.user.findUnique({ where: { email } });
  if (!targetUser) return sendError(res, 404, 'Pengguna dengan email tersebut tidak ditemukan');

  const existing = await prisma.organizationMember.findUnique({
    where: {
      organizationId_userId: {
        organizationId: id,
        userId: targetUser.id,
      },
    },
  });
  if (existing) return sendError(res, 409, 'Pengguna sudah menjadi anggota organisasi');

  const newMember = await prisma.organizationMember.create({
    data: {
      organizationId: id,
      userId: targetUser.id,
      role: 'MEMBER',
    },
    include: {
      user: {
        select: { id: true, name: true, email: true, avatarUrl: true },
      },
    },
  });

  return res.status(201).json({ success: true, data: newMember });
}

export async function removeMember(req: Request, res: Response) {
  if (!req.userId) return sendError(res, 401, 'Tidak terautentikasi');
  const { id, userId } = req.params;

  const org = await prisma.organization.findUnique({ where: { id } });
  if (!org) return sendError(res, 404, 'Organisasi tidak ditemukan');
  if (org.createdById === userId) {
    return sendError(res, 400, 'Tidak dapat mengeluarkan pembuat organisasi');
  }

  const membership = await getOrgMembership(id, req.userId);
  if (!membership || (membership.role !== 'ADMIN' && req.userId !== userId)) {
    return sendError(res, 403, 'Tidak memiliki izin untuk mengeluarkan anggota ini');
  }

  await prisma.organizationMember.deleteMany({
    where: {
      organizationId: id,
      userId,
    },
  });

  return res.json({ success: true, message: 'Anggota berhasil dikeluarkan' });
}

// Mengajukan Project Baru ke Tim binaan (Status: PENDING)
export async function proposeProject(req: Request, res: Response) {
  if (!req.userId) return sendError(res, 401, 'Tidak terautentikasi');
  const { id } = req.params;
  const body = proposeProjectSchema.parse(req.body);

  const membership = await getOrgMembership(id, req.userId);
  if (!membership) return sendError(res, 403, 'Bukan anggota organisasi ini');

  // Pastikan tim terhubung ke organisasi ini
  const connected = await prisma.organizationTeam.findUnique({
    where: {
      organizationId_teamId: {
        organizationId: id,
        teamId: body.teamId,
      },
    },
    include: {
      team: true,
      organization: true,
    },
  });
  if (!connected) {
    return sendError(res, 422, 'Tim yang dipilih tidak terhubung dengan organisasi ini');
  }

  const proposal = await prisma.projectProposal.create({
    data: {
      organizationId: id,
      teamId: body.teamId,
      createdById: req.userId,
      name: body.name,
      description: body.description,
      status: 'PENDING',
    },
    include: {
      team: { select: { id: true, name: true } },
      organization: { select: { id: true, name: true } },
      createdBy: { select: { id: true, name: true, email: true } },
    },
  });

  // Notifikasi ke seluruh admin tim target
  const teamAdmins = await prisma.teamMember.findMany({
    where: { teamId: body.teamId, role: 'ADMIN' },
    select: { userId: true },
  });

  for (const admin of teamAdmins) {
    await prisma.notification.create({
      data: {
        userId: admin.userId,
        type: 'PROJECT_PROPOSAL',
        title: 'Usulan Project Baru',
        message: `Organisasi "${connected.organization.name}" mengusulkan project baru "${body.name}" untuk tim Anda.`,
      },
    });
    emitToUser(admin.userId, 'notification:new', {
      type: 'PROJECT_PROPOSAL',
      title: 'Usulan Project Baru',
      message: `Organisasi "${connected.organization.name}" mengusulkan project baru "${body.name}".`,
    });
  }

  return res.status(201).json({ success: true, data: proposal });
}

// Mengirim Task ke Project tim binaan (Status: PENDING approval di dalam project)
export async function sendTaskToProject(req: Request, res: Response) {
  if (!req.userId) return sendError(res, 401, 'Tidak terautentikasi');
  const { id } = req.params;
  const body = sendTaskSchema.parse(req.body);

  const membership = await getOrgMembership(id, req.userId);
  if (!membership) return sendError(res, 403, 'Bukan anggota organisasi ini');

  const org = await prisma.organization.findUnique({ where: { id }, select: { name: true } });
  if (!org) return sendError(res, 404, 'Organisasi tidak ditemukan');

  const project = await prisma.project.findUnique({
    where: { id: body.projectId },
    include: { team: true },
  });
  if (!project) return sendError(res, 404, 'Project tidak ditemukan');

  // Pastikan tim tempat project berada terhubung ke organisasi ini
  const connected = await prisma.organizationTeam.findUnique({
    where: {
      organizationId_teamId: {
        organizationId: id,
        teamId: project.teamId,
      },
    },
  });
  if (!connected) {
    return sendError(res, 422, 'Project tidak berada dalam tim yang terhubung dengan organisasi ini');
  }

  // Cari kolom pertama project
  const firstCol = await prisma.boardColumn.findFirst({
    where: { projectId: project.id },
    orderBy: { order: 'asc' },
  });
  if (!firstCol) return sendError(res, 422, 'Project belum memiliki kolom kanban');

  // Buat task dengan approval: PENDING
  const task = await prisma.$transaction(async (tx) => {
    const last = await tx.task.findFirst({
      where: { projectId: project.id },
      orderBy: { number: 'desc' },
      select: { number: true },
    });

    return tx.task.create({
      data: {
        projectId: project.id,
        columnId: firstCol.id,
        number: (last?.number ?? 0) + 1,
        title: body.title,
        description: body.description,
        priority: body.priority,
        dueDate: body.dueDate ? new Date(body.dueDate) : null,
        approval: 'PENDING',
        createdById: req.userId,
        organizationId: id,
      },
      include: {
        project: { include: { team: true } },
        column: true,
        createdBy: { select: { id: true, name: true } },
      },
    });
  });

  // Notifikasi ke seluruh admin tim / approver project
  const teamAdmins = await prisma.teamMember.findMany({
    where: { teamId: project.teamId, role: 'ADMIN' },
    select: { userId: true },
  });

  for (const admin of teamAdmins) {
    await prisma.notification.create({
      data: {
        userId: admin.userId,
        type: 'TASK_ASSIGNED',
        title: 'Task Baru Menunggu Persetujuan',
        message: `Organisasi "${org.name}" mengirim task "${task.title}" ke project "${project.name}".`,
      },
    });
    emitToUser(admin.userId, 'notification:new', {
      type: 'TASK_ASSIGNED',
      title: 'Task Baru Menunggu Persetujuan',
      message: `Organisasi "${org.name}" mengirim task "${task.title}" ke project "${project.name}".`,
    });
  }

  return res.status(201).json({ success: true, data: task });
}
