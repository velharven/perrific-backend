import assert from 'node:assert/strict';
import test from 'node:test';
import { prisma } from './prisma';
import { createDefaultRoles } from './permissions';

test('Organization workflow: propose project, approve proposal, and send pending task', async () => {
  // 1. Setup User, Team, and Organization
  const user = await prisma.user.create({
    data: {
      email: `org-test-${Date.now()}@example.com`,
      name: 'Test Org User',
    },
  });

  const team = await prisma.team.create({
    data: {
      name: `Test Team ${Date.now()}`,
      members: {
        create: {
          userId: user.id,
          role: 'ADMIN',
        },
      },
    },
  });

  const org = await prisma.organization.create({
    data: {
      name: 'BEM Mahasiswa',
      description: 'Organisasi kemahasiswaan',
      createdById: user.id,
      members: {
        create: {
          userId: user.id,
          role: 'ADMIN',
        },
      },
      connectedTeams: {
        create: {
          teamId: team.id,
        },
      },
    },
  });

  try {
    // 2. Propose a project from organization to the connected team
    const proposal = await prisma.projectProposal.create({
      data: {
        organizationId: org.id,
        teamId: team.id,
        createdById: user.id,
        name: 'Pekan Olahraga Mahasiswa',
        description: 'Project tahunan POM',
        status: 'PENDING',
      },
    });

    assert.equal(proposal.status, 'PENDING');
    assert.equal(proposal.name, 'Pekan Olahraga Mahasiswa');
    assert.equal(proposal.approvedProjectId, null);

    // 3. Admin of the team approves the proposal
    const project = await prisma.$transaction(async (tx) => {
      const createdProj = await tx.project.create({
        data: {
          teamId: proposal.teamId,
          name: proposal.name,
          description: proposal.description,
          columns: {
            create: [
              { name: 'To Do', color: '#8A8F98', order: 0 },
              { name: 'In Progress', color: '#0090FF', order: 1 },
              { name: 'Done', color: '#46A758', order: 2 },
            ],
          },
        },
        include: { columns: { orderBy: { order: 'asc' } } },
      });

      await createDefaultRoles(createdProj.id, tx);

      await tx.projectProposal.update({
        where: { id: proposal.id },
        data: {
          status: 'APPROVED',
          approvedProjectId: createdProj.id,
          decidedById: user.id,
          decidedAt: new Date(),
        },
      });

      return createdProj;
    });

    assert.ok(project.id);
    assert.equal(project.columns.length, 3);
    assert.equal(project.columns[0].name, 'To Do');

    const createdRoles = await prisma.projectRole.findMany({ where: { projectId: project.id } });
    assert.ok(createdRoles.length >= 3);
    assert.ok(createdRoles.some((r) => r.name === 'Admin'));
    assert.ok(createdRoles.some((r) => r.name === 'Member'));

    const updatedProposal = await prisma.projectProposal.findUnique({
      where: { id: proposal.id },
    });
    assert.equal(updatedProposal?.status, 'APPROVED');
    assert.equal(updatedProposal?.approvedProjectId, project.id);

    // 4. Send a task from Organization to the approved project
    const firstCol = project.columns[0];
    const task = await prisma.task.create({
      data: {
        projectId: project.id,
        columnId: firstCol.id,
        number: 1,
        title: 'Buat Spanduk POM',
        description: 'Ukuran 4x1 meter',
        priority: 'HIGH',
        approval: 'PENDING',
        createdById: user.id,
        organizationId: org.id,
      },
      include: {
        organization: true,
      },
    });

    assert.equal(task.approval, 'PENDING');
    assert.equal(task.organizationId, org.id);
    assert.equal(task.organization?.name, 'BEM Mahasiswa');

    // 5. Test rejecting another proposal
    const rejectedProposal = await prisma.projectProposal.create({
      data: {
        organizationId: org.id,
        teamId: team.id,
        createdById: user.id,
        name: 'Usulan Ditolak',
        description: 'Usulan yang tidak disetujui',
        status: 'PENDING',
      },
    });

    const updatedRejected = await prisma.projectProposal.update({
      where: { id: rejectedProposal.id },
      data: {
        status: 'REJECTED',
        rejectionReason: 'Anggaran tidak mencukupi',
        decidedById: user.id,
        decidedAt: new Date(),
      },
    });

    assert.equal(updatedRejected.status, 'REJECTED');
    assert.equal(updatedRejected.rejectionReason, 'Anggaran tidak mencukupi');
  } finally {
    // Cleanup test data
    await prisma.organization.delete({ where: { id: org.id } }).catch(() => {});
    await prisma.team.delete({ where: { id: team.id } }).catch(() => {});
    await prisma.user.delete({ where: { id: user.id } }).catch(() => {});
  }
});
