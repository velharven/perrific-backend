import assert from 'node:assert/strict';
import 'dotenv/config';
import { after, afterEach, mock, test } from 'node:test';
import { Prisma, type DailyActivity } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { prisma } from './prisma';
import {
  activityCalendarValues,
  autoSyncTwoWay,
  googleCalendarValues,
  importGoogleEventLocked,
  syncActivityLocked,
  calendarRequest,
  waitForCalendarBaseline,
} from './googleCalendarSync';
import type { GoogleCalendarEventItem } from './googleCalendarClient';
import type { Request, Response as ExpressResponse } from 'express';
import { connect } from '../controllers/googleCalendarController';
import {
  listMyActivities,
  updateActivity,
  addChecklistItem,
  updateChecklistItem,
} from '../controllers/activityController';

const users: string[] = [];
afterEach(async () => {
  for (const userId of users) {
    const connections = await prisma.googleCalendarConnection.findMany({ where: { userId } });
    for (const connection of connections) await waitForCalendarBaseline(connection.id);
  }
  mock.restoreAll();
  for (const id of users.splice(0)) await prisma.user.delete({ where: { id } });
});

function controllerResponse() {
  let payload: { data: any };
  const res = {
    status: () => res,
    json: (value: typeof payload) => {
      payload = value;
      return res;
    },
  } as unknown as ExpressResponse;
  return { res, data: () => payload.data };
}
function request(
  userId: string,
  connectionId?: string,
  body: unknown = {},
  params = {},
  query = {},
) {
  return { userId, body, params, query, get: () => connectionId } as unknown as Request;
}

test('A → B → A keeps separate schedules, pending edits and identical Google IDs', async () => {
  const h = await harness();
  mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    if (String(url).includes('tokeninfo')) return response({});
    if (String(url).includes('userinfo'))
      return response({
        sub:
          (init?.headers as Record<string, string>).Authorization === 'Bearer token-b'
            ? 'subject-b'
            : `subject-${h.userId}`,
        email: 'verified@example.test',
      });
    assert.fail('Switching accounts must not touch Google events.');
  });
  const r = controllerResponse();
  await h.edit({ title: 'A pending title' }, { title: new Date().toISOString() });
  await connect(request(h.userId, undefined, { accessToken: 'token-b' }), r.res);
  const b = r.data().connectionId;
  assert.notEqual(b, h.connectionId);
  const activityB = await prisma.dailyActivity.create({
    data: {
      userId: h.userId,
      calendarConnectionId: b,
      title: 'B schedule',
      date: new Date('2026-09-29'),
      googleEventId: h.remote.id,
      allDay: true,
    },
  });
  await listMyActivities(request(h.userId, b, {}, {}, { calendarScope: 'active' }), r.res);
  assert.deepEqual(
    r.data().map((a: DailyActivity) => a.id),
    [activityB.id],
  );
  assert.equal((await syncActivityLocked(h.userId, h.id)).pushed, false);
  assert.equal((await h.state()).pending, true);
  await assert.rejects(
    updateActivity(
      request(h.userId, h.connectionId, { title: 'stale' }, { activityId: h.id }),
      r.res,
    ),
    { code: 409 },
  );
  await connect(request(h.userId, undefined, { accessToken: 'token-a' }), r.res);
  assert.equal(r.data().connectionId, h.connectionId);
  await listMyActivities(
    request(h.userId, h.connectionId, {}, {}, { calendarScope: 'active' }),
    r.res,
  );
  assert.deepEqual(
    r.data().map((a: DailyActivity) => a.id),
    [h.id],
  );
  assert.equal(r.data()[0].title, 'A pending title');
});

test('a response from A after switching to B is rejected and never retried with B credentials', async () => {
  const h = await harness();
  const b = await prisma.googleCalendarConnection.create({
    data: { userId: h.userId, googleSubject: 'subject-b' },
  });
  let finish!: (response: globalThis.Response) => void;
  let started!: () => void;
  const ready = new Promise<void>((r) => {
    started = r;
  });
  const calls: string[] = [];
  mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    calls.push((init?.headers as Record<string, string>).Authorization);
    started();
    return new Promise<globalThis.Response>((r) => {
      finish = r;
    });
  });
  const pending = calendarRequest(h.userId, '?syncToken=cursor-old', {}, h.connectionId);
  await ready;
  await prisma.user.update({
    where: { id: h.userId },
    data: { googleCalendarConnectionId: b.id, googleCalendarAccessToken: 'token-b' },
  });
  finish(response({ items: [h.remote], nextSyncToken: 'stale-a' }));
  await assert.rejects(pending, { code: 409 });
  assert.deepEqual(calls, ['Bearer test-token']);
  assert.equal((await h.activity())!.calendarConnectionId, h.connectionId);
});

test('300 unchanged schedules require one delta request and no per-card DB reads or writes', async () => {
  const h = await harness();
  const original = (await h.activity())!;
  await prisma.dailyActivity.createMany({
    data: Array.from({ length: 299 }, (_, i) => ({
      userId: h.userId,
      calendarConnectionId: h.connectionId,
      title: `unchanged-${i}`,
      googleEventId: `unchanged-${i}`,
      date: original.date,
      startTime: original.startTime,
      endTime: original.endTime,
    })),
  });
  const queries: string[] = [];
  let capture = true;
  prisma.$use(async (params, next) => {
    if (capture && ['DailyActivity', 'CalendarSyncState'].includes(params.model || ''))
      queries.push(`${params.model}:${params.action}`);
    return next(params);
  });
  const fetch = mock.method(globalThis, 'fetch', async (url: unknown) => {
    assert.equal(new URL(String(url)).searchParams.get('syncToken'), 'cursor-old');
    return response({ items: [], nextSyncToken: 'cursor-new' });
  });
  let result;
  try {
    result = await autoSyncTwoWay(h.userId);
  } finally {
    capture = false;
  }
  assert.equal(fetch.mock.callCount(), 1);
  assert.equal(result.updatedCount, 0);
  assert.ok(queries.length <= 3, `Expected batch queries only: ${queries.join(', ')}`);
  assert.ok(queries.every((query) => /:(findMany|count)$/.test(query)));
});

test('410 rebuilds a paginated canonical baseline and commits its token only after all pages apply', async () => {
  const h = await harness();
  let failLast = true;
  mock.method(globalThis, 'fetch', async (url: unknown) => {
    const p = new URL(String(url)).searchParams;
    if (p.has('syncToken')) return response({}, 410);
    if (p.has('timeMin')) return response({ items: [h.remote] });
    assert.equal(p.get('singleEvents'), 'false');
    assert.equal(p.has('orderBy'), false);
    if (p.get('pageToken') === 'page-2') {
      if (failLast) throw new Error('offline');
      return response({ items: [], nextSyncToken: 'rebuilt-token' });
    }
    return response({ items: [h.remote], nextPageToken: 'page-2' });
  });
  await assert.rejects(autoSyncTwoWay(h.userId));
  assert.equal(
    (await prisma.googleCalendarConnection.findUniqueOrThrow({ where: { id: h.connectionId } }))
      .syncToken,
    null,
  );
  failLast = false;
  const result = await autoSyncTwoWay(h.userId);
  assert.equal(result.baselinePending, true);
  await waitForCalendarBaseline(h.connectionId);
  assert.equal(
    (await prisma.googleCalendarConnection.findUniqueOrThrow({ where: { id: h.connectionId } }))
      .syncToken,
    'rebuilt-token',
  );
});

test('moving, editing and checking a card sends only that event immediately without a calendar list', async () => {
  const h = await harness();
  let remote = { ...h.remote };
  const writes: Record<string, any>[] = [];
  mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    assert.ok(String(url).endsWith(`/${h.remote.id}`));
    if (init?.method === 'PATCH') {
      const payload = JSON.parse(String(init.body));
      writes.push(payload);
      remote = { ...remote, ...payload, etag: `etag-${writes.length}` };
      return response(remote);
    }
    return response(remote);
  });
  const r = controllerResponse();
  await updateActivity(
    request(
      h.userId,
      h.connectionId,
      {
        title: 'New title',
        description: 'New description',
        startTime: '2026-09-29T09:00:00Z',
        endTime: '2026-09-29T10:00:00Z',
      },
      { activityId: h.id },
    ),
    r.res,
  );
  assert.equal(writes.length, 1);
  assert.equal(writes[0].start.dateTime, '2026-09-29T09:00:00.000Z');
  await addChecklistItem(
    request(h.userId, h.connectionId, { text: 'Immediate checklist' }, { activityId: h.id }),
    r.res,
  );
  const item = r.data();
  assert.equal(writes.length, 2);
  assert.ok(writes[1].description.includes('[ ] Immediate checklist'));
  await updateChecklistItem(
    request(h.userId, h.connectionId, { completed: true }, { itemId: item.id }),
    r.res,
  );
  assert.equal(writes.length, 3);
  assert.ok(writes[2].description.includes('[x] Immediate checklist'));
});

test('a recurring parent delta updates linked instances outside the visible range', async () => {
  const h = await harness();
  await prisma.calendarSyncState.update({
    where: { id: (await h.state()).id },
    data: { recurringEventId: 'parent' },
  });
  mock.method(globalThis, 'fetch', async (url: unknown) => {
    if (new URL(String(url)).searchParams.has('syncToken'))
      return response({
        items: [{ id: 'parent', status: 'cancelled' }],
        nextSyncToken: 'new-token',
      });
    assert.fail('A cancelled parent does not need instance GETs');
  });
  const result = await autoSyncTwoWay(h.userId, '2026-11-01', '2026-12-01');
  assert.equal(result.deletedCount, 1);
  assert.equal(await h.activity(), null);
});

test('unknown legacy links are kept and never sent through a newly connected account', async () => {
  const h = await harness();
  await prisma.dailyActivity.update({ where: { id: h.id }, data: { calendarConnectionId: null } });
  await prisma.calendarSyncState.update({
    where: { id: (await h.state()).id },
    data: { calendarConnectionId: null, pending: true },
  });
  const fetch = mock.method(globalThis, 'fetch', async () =>
    response({ items: [], nextSyncToken: 'new-token' }),
  );
  const result = await autoSyncTwoWay(h.userId);
  assert.equal(fetch.mock.callCount(), 1);
  assert.equal(result.pushedCount, 0);
  assert.ok(await h.activity());
  assert.equal((await h.state()).calendarConnectionId, null);
});
after(async () => {
  await prisma.$disconnect();
});

async function harness(linked = true) {
  const user = await prisma.user.create({
    data: {
      email: `calendar-test-${randomUUID()}@example.test`,
      name: 'Calendar test',
      googleCalendarConnected: true,
      googleCalendarAccessToken: 'test-token',
      googleCalendarTokenExpiresAt: new Date(Date.now() + 3600000),
    },
  });
  users.push(user.id);
  const connection = await prisma.googleCalendarConnection.create({
    data: { userId: user.id, googleSubject: `subject-${user.id}`, syncToken: 'cursor-old' },
  });
  await prisma.user.update({
    where: { id: user.id },
    data: { googleCalendarConnectionId: connection.id },
  });
  const activity = await prisma.dailyActivity.create({
    data: {
      userId: user.id,
      calendarConnectionId: connection.id,
      title: 'Original',
      description: 'Description',
      date: new Date('2026-09-29T00:00:00Z'),
      startTime: new Date('2026-09-29T07:00:00Z'),
      endTime: new Date('2026-09-29T08:00:00Z'),
      googleEventId: linked ? 'google-event-a' : null,
    },
  });
  const baseline = activityCalendarValues(activity);
  await prisma.calendarSyncState.create({
    data: {
      activityId: activity.id,
      userId: user.id,
      calendarConnectionId: connection.id,
      googleEventId: activity.googleEventId,
      snapshot: baseline as unknown as Prisma.InputJsonValue,
      localChanges: {},
      googleEtag: 'etag-old',
      pending: !linked,
    },
  });
  const remote: GoogleCalendarEventItem = {
    id: 'google-event-a',
    etag: 'etag-old',
    updated: '2026-09-29T03:00:00Z',
    summary: baseline.title,
    description: baseline.description,
    start: { dateTime: baseline.start },
    end: { dateTime: baseline.end },
  };
  return {
    id: activity.id,
    connectionId: connection.id,
    userId: user.id,
    remote,
    baseline,
    activity: () => prisma.dailyActivity.findUnique({ where: { id: activity.id } }),
    state: () =>
      prisma.calendarSyncState.findUniqueOrThrow({
        where: { userId_activityId: { userId: user.id, activityId: activity.id } },
      }),
    edit: async (data: Partial<DailyActivity>, fields: Record<string, string>) => {
      await prisma.dailyActivity.update({
        where: { id: activity.id },
        data: data as Prisma.DailyActivityUpdateInput,
      });
      await prisma.calendarSyncState.update({
        where: { userId_activityId: { userId: user.id, activityId: activity.id } },
        data: { localChanges: fields, pending: true },
      });
    },
  };
}

const response = (event: unknown, status = 200) =>
  new Response(JSON.stringify(event), { status, headers: { 'Content-Type': 'application/json' } });

test('failed outbound edit remains pending and retries without overwriting the local description', async () => {
  const h = await harness();
  await h.edit({ description: 'Local edit' }, { description: '2026-09-29T03:10:00Z' });
  const fetch = mock.method(globalThis, 'fetch', async () => {
    throw new Error('offline');
  });
  await syncActivityLocked(h.userId, h.id);
  assert.equal((await h.state()).pending, true);
  assert.equal((await h.activity())!.description, 'Local edit');
  fetch.mock.mockImplementation(async (_url: unknown, init?: RequestInit) => {
    if (init?.method === 'PATCH') {
      const payload = JSON.parse(String(init.body));
      assert.equal(payload.description, 'Local edit');
      return response({ ...h.remote, description: payload.description, etag: 'etag-new' });
    }
    return response(h.remote);
  });
  await syncActivityLocked(h.userId, h.id);
  assert.equal((await h.state()).pending, false);
  assert.equal((await h.activity())!.description, 'Local edit');
});

test('a Google deletion removes only the daily schedule and is never recreated by POST', async () => {
  const h = await harness();
  const calls: string[] = [];
  mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    calls.push(init?.method || 'GET');
    return response({}, 404);
  });
  const result = await syncActivityLocked(h.userId, h.id);
  assert.equal(result.deleted, true);
  assert.equal(await h.activity(), null);
  assert.equal((await h.state()).pendingDelete, true);
  assert.deepEqual(calls, ['GET']);
  assert.equal(await importGoogleEventLocked(h.userId, h.remote), null);
});

test('a lost insert response reuses its persisted event ID rather than creating a duplicate', async () => {
  const h = await harness(false);
  let inserted: GoogleCalendarEventItem | null = null;
  let posts = 0;
  mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    if (init?.method === 'POST') {
      posts++;
      inserted = JSON.parse(String(init.body));
      throw new Error('response lost');
    }
    return inserted ? response(inserted) : response({}, 404);
  });
  await syncActivityLocked(h.userId, h.id);
  const allocatedId = (await h.state()).googleEventId;
  assert.ok(allocatedId);
  assert.equal((await h.state()).pending, true);
  const retry = await syncActivityLocked(h.userId, h.id);
  assert.equal(posts, 1);
  assert.equal(retry.googleEventId, allocatedId);
  assert.equal((await h.activity())!.googleEventId, allocatedId);
});

test('412 retries merge the latest Google description with the local title', async () => {
  const h = await harness();
  await h.edit({ title: 'Local title' }, { title: '2026-09-29T03:10:00Z' });
  let gets = 0;
  let patches = 0;
  mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    if (init?.method === 'PATCH') {
      patches++;
      if (patches === 1) return response({}, 412);
      const payload = JSON.parse(String(init.body));
      assert.equal(payload.summary, 'Local title');
      assert.equal(payload.description, 'Google description');
      assert.equal((init.headers as Record<string, string>)['If-Match'], 'etag-latest');
      return response({ ...h.remote, ...payload, id: h.remote.id, etag: 'etag-final' });
    }
    gets++;
    return response(
      gets === 1
        ? h.remote
        : {
            ...h.remote,
            description: 'Google description',
            etag: 'etag-latest',
            updated: '2026-09-29T03:11:00Z',
          },
    );
  });
  await syncActivityLocked(h.userId, h.id);
  assert.equal(patches, 2);
  assert.equal((await h.activity())!.title, 'Local title');
  assert.equal((await h.activity())!.description, 'Google description');
  assert.equal((await h.state()).pending, false);
});

test('generated checklist text is not imported into the editable description', async () => {
  const h = await harness();
  const values = { ...h.baseline, checklist: '\n\nChecklist:\n[x] Done' };
  assert.equal(
    googleCalendarValues({ ...h.remote, description: 'Description' + values.checklist }, values)
      .description,
    'Description',
  );
});

test('304 keeps the baseline and still pushes a pending local edit with its ETag', async () => {
  const h = await harness();
  await h.edit({ title: 'Changed title' }, { title: '2026-09-29T03:10:00Z' });
  mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    const headers = init?.headers as Record<string, string>;
    if (init?.method === 'PATCH') {
      assert.equal(headers['If-Match'], 'etag-old');
      const payload = JSON.parse(String(init.body));
      assert.equal(payload.summary, 'Changed title');
      assert.equal(payload.description, 'Description');
      return response({ ...h.remote, ...payload, etag: 'etag-new' });
    }
    assert.equal(headers['If-None-Match'], 'etag-old');
    return new Response(null, { status: 304 });
  });
  const synced = await syncActivityLocked(h.userId, h.id);
  assert.equal(synced.pushed, true);
  assert.equal((await h.state()).pending, false);
  assert.equal((await h.activity())!.title, 'Changed title');
});

test('editing a title preserves Google recurrence exceptions and other private properties', async () => {
  const h = await harness();
  const recurrence = ['RRULE:FREQ=WEEKLY;BYDAY=TU', 'EXDATE:20261006T070000Z'];
  await prisma.dailyActivity.update({
    where: { id: h.id },
    data: { recurrence: { freq: 'WEEKLY', byDays: [2] } },
  });
  await prisma.calendarSyncState.update({
    where: { id: (await h.state()).id },
    data: {
      snapshot: { ...h.baseline, recurrence } as unknown as Prisma.InputJsonValue,
    },
  });
  await h.edit({ title: 'Local title' }, { title: '2026-09-29T03:10:00Z' });
  mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    if (init?.method === 'PATCH') {
      const payload = JSON.parse(String(init.body));
      assert.deepEqual(payload.recurrence, recurrence);
      assert.equal(payload.extendedProperties.private.otherApp, 'retained');
      return response({ ...h.remote, ...payload, etag: 'etag-new' });
    }
    return response({
      ...h.remote,
      recurrence,
      extendedProperties: { private: { otherApp: 'retained' } },
    });
  });
  assert.equal((await syncActivityLocked(h.userId, h.id)).pushed, true);
});

test('incremental sync updates an out-of-range deletion without any per-card GET', async () => {
  const h = await harness();
  const calls: string[] = [];
  mock.method(globalThis, 'fetch', async (url: unknown) => {
    const parsed = new URL(String(url));
    calls.push(parsed.pathname);
    assert.equal(parsed.searchParams.get('singleEvents'), 'false');
    assert.equal(parsed.searchParams.get('syncToken'), 'cursor-old');
    assert.equal(parsed.searchParams.has('timeMin'), false);
    return response({
      items: [{ id: h.remote.id, status: 'cancelled' }],
      nextSyncToken: 'cursor-new',
    });
  });
  const result = await autoSyncTwoWay(h.userId, '2026-10-01T00:00:00Z', '2026-10-02T00:00:00Z');
  assert.equal(result.deletedCount, 1);
  assert.equal(result.pendingCount, 0);
  assert.equal(await h.activity(), null);
  assert.equal(calls.length, 1);
});

test('a title edit does not shorten a Google all-day event spanning multiple days', async () => {
  const h = await harness();
  const baseline = { ...h.baseline, start: '2026-09-29', end: '2026-10-02' };
  await prisma.dailyActivity.update({
    where: { id: h.id },
    data: { allDay: true, startTime: null, endTime: null },
  });
  await prisma.calendarSyncState.update({
    where: { id: (await h.state()).id },
    data: {
      snapshot: baseline as unknown as Prisma.InputJsonValue,
    },
  });
  await h.edit({ title: 'Changed title' }, { title: '2026-09-29T03:10:00Z' });
  mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    if (init?.method === 'PATCH') {
      const payload = JSON.parse(String(init.body));
      assert.equal(payload.end.date, '2026-10-02');
      assert.equal(payload.start.date, '2026-09-29');
      return response({ ...h.remote, ...payload, etag: 'etag-new' });
    }
    return response({ ...h.remote, start: { date: baseline.start }, end: { date: baseline.end } });
  });
  assert.equal((await syncActivityLocked(h.userId, h.id)).pushed, true);
  assert.equal((await h.state()).pending, false);
});
