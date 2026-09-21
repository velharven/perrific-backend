import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { randomInviteCode } from '../src/lib/inviteCode';

const prisma = new PrismaClient();

async function main() {
  const passwordHash = await bcrypt.hash('password123', 10);

  const admin = await prisma.user.upsert({
    where: { email: 'admin@example.com' },
    update: {},
    create: {
      email: 'admin@example.com',
      name: 'Team Admin',
      passwordHash,
    },
  });

  const user = await prisma.user.upsert({
    where: { email: 'member@example.com' },
    update: {},
    create: {
      email: 'member@example.com',
      name: 'Team Member',
      passwordHash,
    },
  });

  const team = await prisma.team.upsert({
    where: { id: 'seed-team' },
    update: { inviteCode: 'CONTOH01' },
    create: {
      id: 'seed-team',
      name: 'Tim Contoh',
      description: 'Tim contoh untuk demo',
      // Kode tetap untuk testing alur masuk-tim (login akun lain → Masuk tim).
      inviteCode: 'CONTOH01',
      members: {
        create: [
          { userId: admin.id, role: 'ADMIN' },
          { userId: user.id, role: 'MEMBER' },
        ],
      },
    },
  });

  const project = await prisma.project.upsert({
    where: { id: 'seed-project' },
    update: {},
    create: {
      id: 'seed-project',
      teamId: team.id,
      name: 'Proyek Contoh',
      description: 'Proyek contoh untuk demo MRV',
    },
  });

  // Kolom bawaan untuk seed project (idempotent per nama).
  const defaultColumns = [
    { name: 'To Do', color: '#8A8F98', order: 0 },
    { name: 'In Progress', color: '#0090FF', order: 1 },
    { name: 'Done', color: '#46A758', order: 2 },
  ];
  for (const col of defaultColumns) {
    const existing = await prisma.boardColumn.findFirst({
      where: { projectId: project.id, name: col.name },
    });
    if (!existing) {
      await prisma.boardColumn.create({
        data: { projectId: project.id, name: col.name, color: col.color, order: col.order },
      });
    }
  }
  const firstColumn = await prisma.boardColumn.findFirst({
    where: { projectId: project.id },
    orderBy: { order: 'asc' },
  });

  await prisma.task.upsert({
    where: { id: 'seed-task' },
    update: {},
    create: {
      id: 'seed-task',
      projectId: project.id,
      columnId: firstColumn!.id,
      assignees: { create: [{ userId: user.id }] },
      title: 'Task contoh pertama',
      priority: 'MEDIUM',
    },
  });

  console.log('Seed selesai.');

  // Backfill idempoten: tim lama yang belum punya kode (kolom baru nullable).
  // seed-team sudah berkode via upsert di atas sehingga tak ikut.
  const codeless = await prisma.team.findMany({ where: { inviteCode: null } });
  for (const t of codeless) {
    await prisma.team
      .update({ where: { id: t.id }, data: { inviteCode: randomInviteCode() } })
      .catch(() => {});
  }
  if (codeless.length > 0) console.log(`Backfill ${codeless.length} kode tim selesai.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
