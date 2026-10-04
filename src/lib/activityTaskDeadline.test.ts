import test from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from './prisma';
import { listMyActivities, createActivity, updateActivity } from '../controllers/activityController';

test('activityController returns task dueDate when activity is linked to a task', async () => {
  const user = await prisma.user.create({
    data: { email: `user-due-${Date.now()}@example.com`, name: 'User Deadline Test' },
  });

  const team = await prisma.team.create({
    data: {
      name: `Team Due Test ${Date.now()}`,
      members: { create: { userId: user.id, role: 'ADMIN' } },
    },
  });

  const project = await prisma.project.create({
    data: {
      teamId: team.id,
      name: 'Project Due Test',
      columns: { create: [{ name: 'To Do', order: 0 }] },
    },
    include: { columns: true },
  });

  const targetDueDate = new Date('2026-10-25T00:00:00.000Z');
  const task = await prisma.task.create({
    data: {
      projectId: project.id,
      columnId: project.columns[0].id,
      number: 1,
      title: 'Tugas dengan Deadline',
      priority: 'HIGH',
      approval: 'APPROVED',
      dueDate: targetDueDate,
      createdById: user.id,
    },
  });

  let createdActivityId: string | null = null;

  try {
    // 1. Test createActivity with taskId
    let createStatusCode = 200;
    let createResult: any = null;
    const createReq: any = {
      userId: user.id,
      body: {
        title: 'Jadwal Tugas Deadline',
        taskId: task.id,
        date: '2026-10-10T00:00:00.000Z',
        allDay: true,
      },
    };
    const createRes: any = {
      status(code: number) { createStatusCode = code; return this; },
      json(data: any) { createResult = data; return this; },
    };

    await createActivity(createReq, createRes);
    assert.equal(createStatusCode, 201);
    assert.equal(createResult?.success, true);
    assert.ok(createResult?.data?.task);
    assert.equal(createResult?.data?.task?.id, task.id);
    assert.ok(createResult?.data?.task?.dueDate, 'task.dueDate must be present in created activity');
    assert.equal(new Date(createResult.data.task.dueDate).toISOString(), targetDueDate.toISOString());

    createdActivityId = createResult.data.id;

    // 2. Test listActivities
    let listStatusCode = 200;
    let listResult: any = null;
    const listReq: any = {
      userId: user.id,
      query: { taskId: task.id },
    };
    const listRes: any = {
      status(code: number) { listStatusCode = code; return this; },
      json(data: any) { listResult = data; return this; },
    };

    await listMyActivities(listReq, listRes);
    assert.equal(listStatusCode, 200);
    assert.equal(listResult?.success, true);
    assert.ok(listResult?.data?.length > 0);
    const listedAct = listResult.data.find((a: any) => a.id === createdActivityId);
    assert.ok(listedAct);
    assert.ok(listedAct.task?.dueDate, 'task.dueDate must be present in listActivities');
    assert.equal(new Date(listedAct.task.dueDate).toISOString(), targetDueDate.toISOString());

    // 3. Test updateActivity
    let updateStatusCode = 200;
    let updateResult: any = null;
    const updateReq: any = {
      userId: user.id,
      params: { activityId: createdActivityId },
      body: { title: 'Jadwal Tugas Deadline Updated' },
    };
    const updateRes: any = {
      status(code: number) { updateStatusCode = code; return this; },
      json(data: any) { updateResult = data; return this; },
    };

    await updateActivity(updateReq, updateRes);
    assert.equal(updateStatusCode, 200);
    assert.equal(updateResult?.success, true);
    assert.ok(updateResult?.data?.task?.dueDate, 'task.dueDate must be present in updateActivity');
    assert.equal(new Date(updateResult.data.task.dueDate).toISOString(), targetDueDate.toISOString());
  } finally {
    if (createdActivityId) {
      await prisma.dailyActivity.deleteMany({ where: { id: createdActivityId } }).catch(() => {});
    }
    await prisma.task.deleteMany({ where: { id: task.id } }).catch(() => {});
    await prisma.boardColumn.deleteMany({ where: { projectId: project.id } }).catch(() => {});
    await prisma.project.deleteMany({ where: { id: project.id } }).catch(() => {});
    await prisma.teamMember.deleteMany({ where: { teamId: team.id } }).catch(() => {});
    await prisma.team.deleteMany({ where: { id: team.id } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: user.id } }).catch(() => {});
  }
});
