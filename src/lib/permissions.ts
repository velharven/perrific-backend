import { prisma } from './prisma';

// Kunci izin project (dicentang per role di tab Role).
export const PERMISSIONS = [
  'task.create',
  'task.move',
  'task.delete',
  'task.approve',
  'member.approve',
  'column.manage',
  'invite.manage',
  'project.manage',
  'role.manage',
] as const;

export type PermissionKey = (typeof PERMISSIONS)[number];

export const ALL_PERMISSIONS: string[] = [...PERMISSIONS];

const MEMBER_PERMS = ['task.create', 'task.move'];
const APPROVER_PERMS = ['task.create', 'task.move', 'task.approve', 'member.approve'];

// Role bawaan tiap project: Admin, Approver, Member + contoh divisi.
export async function createDefaultRoles(projectId: string) {
  const defs: { name: string; system: string | null; permissions: string[] }[] = [
    { name: 'Admin', system: 'ADMIN', permissions: ALL_PERMISSIONS },
    { name: 'Approver', system: 'APPROVER', permissions: APPROVER_PERMS },
    { name: 'Member', system: 'MEMBER', permissions: MEMBER_PERMS },
    { name: 'Front', system: null, permissions: MEMBER_PERMS },
    { name: 'Back', system: null, permissions: MEMBER_PERMS },
    { name: 'Design', system: null, permissions: MEMBER_PERMS },
  ];
  for (const d of defs) {
    await prisma.projectRole.upsert({
      where: { projectId_name: { projectId, name: d.name } },
      update: {},
      create: { projectId, name: d.name, system: d.system, permissions: d.permissions },
    });
  }
}

async function defaultMemberRoleId(projectId: string): Promise<string | null> {
  let role = await prisma.projectRole.findUnique({
    where: { projectId_name: { projectId, name: 'Member' } },
  });
  if (!role) {
    await createDefaultRoles(projectId);
    role = await prisma.projectRole.findUnique({
      where: { projectId_name: { projectId, name: 'Member' } },
    });
  }
  return role?.id ?? null;
}

// Pastikan user anggota tim punya baris ProjectMember (malas: dibuat saat
// dibutuhkan agar project lama/divisi baru tetap konsisten).
export async function ensureProjectMember(projectId: string, userId: string) {
  const existing = await prisma.projectMember.findUnique({
    where: { projectId_userId: { projectId, userId } },
  });
  if (existing) return existing;
  const roleId = await defaultMemberRoleId(projectId);
  if (!roleId) return null;
  try {
    return await prisma.projectMember.create({ data: { projectId, userId, roleId } });
  } catch {
    return prisma.projectMember.findUnique({ where: { projectId_userId: { projectId, userId } } });
  }
}

// Cek izin di salah satu project dalam tim (untuk antrean level tim).
export async function canAny(userId: string | undefined, teamId: string, perm: PermissionKey): Promise<boolean> {
  if (!userId) return false;
  const membership = await prisma.teamMember.findFirst({ where: { teamId, userId } });
  if (!membership) return false;
  if (membership.role === 'ADMIN') return true;
  const rows = await prisma.projectMember.findMany({
    where: { userId, project: { teamId } },
    select: { role: { select: { permissions: true } } },
  });
  return rows.some((r) => r.role.permissions.includes(perm));
}

// Cek izin: ADMIN tim lolos semua; selainnya ikut permissions role project-nya.
export async function can(userId: string | undefined, projectId: string, perm: PermissionKey): Promise<boolean> {
  if (!userId) return false;
  const teamMembership = await prisma.teamMember.findFirst({
    where: { userId, team: { projects: { some: { id: projectId } } } },
    select: { role: true },
  });
  if (!teamMembership) return false;
  if (teamMembership.role === 'ADMIN') return true;
  const member = await ensureProjectMember(projectId, userId);
  if (!member) return false;
  const role = await prisma.projectRole.findUnique({
    where: { id: member.roleId },
    select: { permissions: true },
  });
  return role?.permissions.includes(perm) ?? false;
}
