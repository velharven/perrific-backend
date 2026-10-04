import test from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from './prisma';
import { approveTask } from '../controllers/taskController';

test('approveTask approves pending task and assigns specified member(s)', async () => {
  const admin = await prisma.user.create({
    data: { email: `admin-appr-${Date.now()}@example.com`, name: 'Admin Approver' },
  });
  const proposer = await prisma.user.create({
    data: { email: `proposer-appr-${Date.now()}@example.com`, name: 'Proposer User' },
  });
  const assignee = await prisma.user.create({
    data: { email: `assignee-appr-${Date.now()}@example.com`, name: 'Assigned User' },
  });

  const team = await prisma.team.create({
    data: {
      name: `Team Task Approval ${Date.now()}`,
      members: {
        create: [
          { userId: admin.id, role: 'ADMIN' },
          { userId: proposer.id, role: 'MEMBER' },
          { userId: assignee.id, role: 'MEMBER' },
        ],
      },
    },
  });

  const project = await prisma.project.create({
    data: {
      teamId: team.id,
      name: 'Project Task Appr',
      columns: {
        create: [{ name: 'To Do', order: 0 }],
      },
    },
    include: { columns: true },
  });

  const column = project.columns[0];

  const task = await prisma.task.create({
    data: {
      projectId: project.id,
      columnId: column.id,
      number: 1,
      title: 'Fitur Approval Popup',
      approval: 'PENDING',
      createdById: proposer.id,
    },
  });

  try {
    let jsonResult: any = null;
    let statusCode = 200;
    const req: any = {
      userId: admin.id,
      params: { taskId: task.id },
      body: { assigneeIds: [assignee.id] },
    };
    const res: any = {
      status(code: number) { statusCode = code; return this; },
      json(data: any) { jsonResult = data; return this; },
    };

    await approveTask(req, res);

    assert.equal(statusCode, 200);
    assert.equal(jsonResult?.success, true);
    assert.equal(jsonResult?.data?.approval, 'APPROVED');
    assert.equal(jsonResult?.data?.assignees?.length, 1);
    assert.equal(jsonResult?.data?.assignees?.[0]?.id, assignee.id);

    // Verify in database
    const dbTask = await prisma.task.findUnique({
      where: { id: task.id },
      include: { assignees: true, activities: true },
    });
    assert.equal(dbTask?.approval, 'APPROVED');
    assert.equal(dbTask?.assignees.length, 1);
    assert.equal(dbTask?.assignees[0].userId, assignee.id);
    assert.ok(dbTask?.activities.some((a) => a.kind === 'ASSIGNED' && a.targetUserId === assignee.id));
  } finally {
    await prisma.taskActivity.deleteMany({ where: { taskId: task.id } }).catch(() => {});
    await prisma.taskAssignee.deleteMany({ where: { taskId: task.id } }).catch(() => {});
    await prisma.task.deleteMany({ where: { id: task.id } }).catch(() => {});
    await prisma.boardColumn.deleteMany({ where: { projectId: project.id } }).catch(() => {});
    await prisma.project.deleteMany({ where: { id: project.id } }).catch(() => {});
    await prisma.teamMember.deleteMany({ where: { teamId: team.id } }).catch(() => {});
    await prisma.team.deleteMany({ where: { id: team.id } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: [admin.id, proposer.id, assignee.id] } } }).catch(() => {});
  }
});

test('approveTask with empty assigneeIds ("Atur nanti") approves task without assignees', async () => {
  const admin = await prisma.user.create({
    data: { email: `admin-later-${Date.now()}@example.com`, name: 'Admin Approver Later' },
  });
  const proposer = await prisma.user.create({
    data: { email: `proposer-later-${Date.now()}@example.com`, name: 'Proposer Later' },
  });

  const team = await prisma.team.create({
    data: {
      name: `Team Task Approval Later ${Date.now()}`,
      members: {
        create: [
          { userId: admin.id, role: 'ADMIN' },
          { userId: proposer.id, role: 'MEMBER' },
        ],
      },
    },
  });

  const project = await prisma.project.create({
    data: {
      teamId: team.id,
      name: 'Project Task Later',
      columns: {
        create: [{ name: 'To Do', order: 0 }],
      },
    },
    include: { columns: true },
  });

  const column = project.columns[0];

  const task = await prisma.task.create({
    data: {
      projectId: project.id,
      columnId: column.id,
      number: 2,
      title: 'Task Atur Nanti',
      approval: 'PENDING',
      createdById: proposer.id,
    },
  });

  try {
    let jsonResult: any = null;
    let statusCode = 200;
    const req: any = {
      userId: admin.id,
      params: { taskId: task.id },
      body: { assigneeIds: [] },
    };
    const res: any = {
      status(code: number) { statusCode = code; return this; },
      json(data: any) { jsonResult = data; return this; },
    };

    await approveTask(req, res);

    assert.equal(statusCode, 200);
    assert.equal(jsonResult?.success, true);
    assert.equal(jsonResult?.data?.approval, 'APPROVED');
    assert.equal(jsonResult?.data?.assignees?.length, 0);

    const dbTask = await prisma.task.findUnique({
      where: { id: task.id },
      include: { assignees: true },
    });
    assert.equal(dbTask?.approval, 'APPROVED');
    assert.equal(dbTask?.assignees.length, 0);
  } finally {
    await prisma.taskAssignee.deleteMany({ where: { taskId: task.id } }).catch(() => {});
    await prisma.task.deleteMany({ where: { id: task.id } }).catch(() => {});
    await prisma.boardColumn.deleteMany({ where: { projectId: project.id } }).catch(() => {});
    await prisma.project.deleteMany({ where: { id: project.id } }).catch(() => {});
    await prisma.teamMember.deleteMany({ where: { teamId: team.id } }).catch(() => {});
    await prisma.team.deleteMany({ where: { id: team.id } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: [admin.id, proposer.id] } } }).catch(() => {});
  }
});
