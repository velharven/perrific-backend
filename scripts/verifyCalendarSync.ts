import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { env } from '../src/config/env';
import { prisma } from '../src/lib/prisma';
import { calendarRequest, googleCalendarValues, readGoogleEvent } from '../src/lib/googleCalendarSync';
import type { CalendarValues } from '../src/lib/calendarMerge';

// Explicit live check: creates a temporary personal task and Google events, then removes them.
async function verify() {
  const users = await prisma.user.findMany({
    where: {
      googleCalendarConnected: true,
      NOT: { googleCalendarAccessToken: 'test-token' },
      ...(process.env.CALENDAR_TEST_USER_ID ? { id: process.env.CALENDAR_TEST_USER_ID } : {}),
    },
    select: { id: true },
  });
  assert.equal(
    users.length,
    1,
    'Specify CALENDAR_TEST_USER_ID when multiple Google accounts are connected.',
  );
  const userId = users[0].id;
  if (process.argv.includes('--inspect-existing')) {
    const activity = await prisma.dailyActivity.findFirst({ where: { userId,
      googleEventId: { not: null }, task: { project: { teamId: `personal-${userId}` },
        NOT: { title: { startsWith: '[Calendar verification ' } } } },
      orderBy: { createdAt: 'desc' }, include: { task: true } });
    assert.ok(activity?.task && activity.googleEventId, 'No scheduled personal task found.');
    const event = await readGoogleEvent(userId, activity.googleEventId);
    assert.ok(event, 'Existing personal task must have an active Google event.');
    const state = await prisma.calendarSyncState.findUnique({ where: {
      userId_activityId: { userId, activityId: activity.id },
    } });
    const remote = googleCalendarValues(event, state?.snapshot as unknown as CalendarValues | null);
    assert.equal(activity.title, activity.task.title);
    assert.equal(remote.title, activity.title);
    assert.equal(activity.description || '', activity.task.description || '');
    assert.equal(remote.description, activity.description || '');
    if (activity.startTime) assert.equal(remote.start, activity.startTime.toISOString());
    assert.equal(state?.pending, false);
    console.log('PASS latest existing personal task matches Daily and Google title, description, and time');
    return;
  }
  const token = jwt.sign({ userId }, env.jwtSecret, { expiresIn: '10m' });
  const base = `http://localhost:${env.port}/api`;
  async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(base + path, {
      method,
      signal: AbortSignal.timeout(60000),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const payload = (await response.json()) as { data: T; message?: string };
    assert.ok(response.ok, `${method} ${path}: ${response.status} ${payload.message || ''}`);
    return payload.data;
  }
  let taskId: string | undefined;
  const activityIds: string[] = [];
  const eventIds: string[] = [];
  const label = `[Calendar verification ${randomUUID().slice(0, 8)}]`;
  const start = new Date(Date.now() + 2 * 3600000);
  start.setSeconds(0, 0);
  const end = new Date(start.getTime() + 3600000);
  const sync = () =>
    api('POST', '/calendar/google/auto-sync', {
      startDate: new Date(start.getTime() - 60000).toISOString(),
      endDate: new Date(end.getTime() + 60000).toISOString(),
    });
  // Recover only fixtures from an interrupted invocation of this same verifier.
  const previous = await prisma.task.findMany({
    where: {
      project: { teamId: `personal-${userId}` },
      title: { startsWith: '[Calendar verification ' },
    },
    select: { id: true, title: true },
  });
  for (const fixture of previous) {
    if (/^\[Calendar verification [a-f0-9]{8}\]/.test(fixture.title)) {
      await api('DELETE', `/tasks/${fixture.id}`);
      console.log('Cleaned interrupted verification fixture');
    }
  }
  try {
    const project = await api<{ id: string }>('GET', '/projects/personal/me');
    const task = await api<{ id: string }>('POST', `/projects/${project.id}/tasks`, {
      title: label,
      description: 'Original description',
    });
    taskId = task.id;
    const schedule = async () => {
      const activity = await api<{
        id: string;
        title: string;
        description: string;
        googleEventId: string;
      }>('POST', '/activities', {
        taskId,
        title: 'Stale client title',
        description: 'Stale client description',
        type: 'TASK',
        date: start.toISOString(),
        startTime: start.toISOString(),
        endTime: end.toISOString(),
      });
      activityIds.push(activity.id);
      assert.ok(activity.googleEventId, 'Scheduled task must receive a Google event ID.');
      eventIds.push(activity.googleEventId);
      return activity;
    };
    const activity = await schedule();
    assert.equal(activity.title, label);
    assert.equal(activity.description, 'Original description');
    assert.equal(
      (await readGoogleEvent(userId, activity.googleEventId))?.description,
      'Original description',
    );
    console.log(
      'PASS personal task scheduling copies server title/description and creates one Google event',
    );

    await api('PATCH', `/tasks/${taskId}`, {
      title: `${label} project edit`,
      description: 'Project description',
    });
    assert.equal(
      (await readGoogleEvent(userId, activity.googleEventId))?.description,
      'Project description',
    );
    await api('PATCH', `/activities/${activity.id}`, {
      title: `${label} Daily edit`,
      description: 'Daily description',
    });
    assert.equal(
      (await api<{ description: string }>('GET', `/tasks/${taskId}`)).description,
      'Daily description',
    );
    console.log('PASS project edits reach Google; Daily edits reach the source task');

    const changed = await calendarRequest(userId, `/${activity.googleEventId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        summary: `${label} Google edit`,
        description: 'Google description',
        start: { dateTime: new Date(start.getTime() + 15 * 60000).toISOString() },
        end: { dateTime: new Date(end.getTime() + 15 * 60000).toISOString() },
      }),
    });
    assert.ok(changed.ok, 'Google edit must succeed.');
    await sync();
    const fromGoogle = await api<{ title: string; description: string }>('GET', `/tasks/${taskId}`);
    assert.equal(fromGoogle.title, `${label} Google edit`);
    assert.equal(fromGoogle.description, 'Google description');
    const daily = await prisma.dailyActivity.findUniqueOrThrow({ where: { id: activity.id } });
    assert.equal(daily.startTime?.getTime(), start.getTime() + 15 * 60000);
    console.log(
      'PASS Google edits update the source task, Daily title/description, and scheduling time',
    );

    await api('PATCH', `/tasks/${taskId}`, { description: null });
    assert.equal((await readGoogleEvent(userId, activity.googleEventId))?.description || '', '');
    console.log('PASS clearing description propagates to Google');

    assert.ok(
      (await calendarRequest(userId, `/${activity.googleEventId}`, { method: 'DELETE' })).ok,
    );
    await sync();
    assert.equal(await prisma.dailyActivity.findUnique({ where: { id: activity.id } }), null);
    assert.ok(await prisma.task.findUnique({ where: { id: taskId } }));
    console.log(
      'PASS deleting the Google schedule keeps the source task available for rescheduling',
    );

    const rescheduled = await schedule();
    assert.notEqual(rescheduled.googleEventId, activity.googleEventId);
    await api('DELETE', `/tasks/${taskId}`);
    assert.equal(await prisma.dailyActivity.findUnique({ where: { id: rescheduled.id } }), null);
    assert.equal(await readGoogleEvent(userId, rescheduled.googleEventId), null);
    console.log('PASS deleting the source task removes its Daily and Google schedules');
  } finally {
    let cleanupError: unknown;
    if (taskId && (await prisma.task.findUnique({ where: { id: taskId } }))) {
      try {
        await api('DELETE', `/tasks/${taskId}`);
      } catch (error) {
        cleanupError = error;
      }
    }
    for (const eventId of eventIds) {
      try {
        const response = await calendarRequest(userId, `/${eventId}`, { method: 'DELETE' });
        assert.ok(
          response.ok || response.status === 404 || response.status === 410,
          'Temporary Google event cleanup failed.',
        );
      } catch (error) {
        cleanupError = error;
      }
    }
    if (cleanupError) throw cleanupError;
    await prisma.dailyActivity.deleteMany({ where: { userId, id: { in: activityIds } } });
    if (taskId) await prisma.task.deleteMany({ where: { id: taskId } });
    await prisma.calendarSyncState.deleteMany({
      where: { userId, activityId: { in: activityIds } },
    });
    console.log('Temporary verification task and events cleaned up');
  }
}

verify()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Calendar verification failed');
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
