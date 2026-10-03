import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, mock, test } from 'node:test';
import type { Request, Response } from 'express';
import { disconnect } from '../controllers/googleCalendarController';
import { withUserCalendarLock } from './calendarOperationLock';
import { refreshGoogleAccessToken } from './googleCalendarClient';
import { encryptToken } from './crypto';
import { prisma } from './prisma';

const users: string[] = [];
afterEach(async () => {
  mock.restoreAll();
  for (const id of users.splice(0)) await prisma.user.delete({ where: { id } });
});
after(() => prisma.$disconnect());

async function fixture() {
  const user = await prisma.user.create({
    data: {
      email: `calendar-disconnect-${randomUUID()}@example.test`,
      name: 'Disconnect fixture',
      googleCalendarConnected: true,
      googleCalendarAccessToken: 'test-token',
      googleCalendarRefreshToken: 'test-refresh',
      googleCalendarTokenExpiresAt: new Date(Date.now() + 3600000),
      googleCalendarEmail: 'calendar@example.test',
      googleCalendarName: 'Google fixture',
      googleCalendarAvatarUrl: 'https://example.test/avatar',
      googleCalendarSyncedAt: new Date(),
    },
  });
  users.push(user.id);
  await prisma.dailyActivity.create({
    data: {
      userId: user.id,
      title: 'Keep schedule',
      date: new Date('2026-09-29T00:00:00Z'),
      startTime: new Date('2026-09-29T07:00:00Z'),
      endTime: new Date('2026-09-29T08:00:00Z'),
      googleEventId: 'retained-event',
    },
  });
  const payloads: unknown[] = [];
  const response = {
    json: (value: unknown) => {
      payloads.push(value);
      return response;
    },
  } as unknown as Response;
  return {
    userId: user.id,
    payloads,
    runDisconnect: () => disconnect({ userId: user.id } as Request, response),
  };
}

test('disconnect completes after the active calendar operation and preserves schedules', async () => {
  const h = await fixture();
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const sync = withUserCalendarLock(h.userId, () => pending);
  const disconnecting = h.runDisconnect();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.payloads.length, 0);
  finish();
  await Promise.all([sync, disconnecting]);
  const user = await prisma.user.findUniqueOrThrow({ where: { id: h.userId } });
  assert.equal(user.googleCalendarConnected, false);
  for (const field of [
    'googleCalendarAccessToken',
    'googleCalendarRefreshToken',
    'googleCalendarTokenExpiresAt',
    'googleCalendarEmail',
    'googleCalendarName',
    'googleCalendarAvatarUrl',
    'googleCalendarSyncedAt',
  ] as const) {
    assert.equal(user[field], null);
  }
  assert.deepEqual(h.payloads, [{ success: true, data: { connected: false, connectionId: null } }]);
  assert.equal(
    await prisma.dailyActivity.count({
      where: { userId: h.userId, googleEventId: 'retained-event' },
    }),
    1,
  );
});

test('a token refresh started before disconnect cannot restore the Google connection', async () => {
  const h = await fixture();
  const originalId = process.env.GOOGLE_CLIENT_ID;
  const originalSecret = process.env.GOOGLE_CLIENT_SECRET;
  process.env.GOOGLE_CLIENT_ID = 'fixture-client';
  process.env.GOOGLE_CLIENT_SECRET = 'fixture-secret';
  let respond!: (value: globalThis.Response) => void;
  let started!: () => void;
  const requestStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  mock.method(globalThis, 'fetch', async (input: unknown) => {
    const urlStr = String(input);
    if (urlStr.includes('/revoke')) {
      return new globalThis.Response(JSON.stringify({}), { status: 200 });
    }
    started();
    return new Promise<globalThis.Response>((resolve) => {
      respond = resolve;
    });
  });
  try {
    const refresh = refreshGoogleAccessToken(h.userId, 'test-refresh');
    await requestStarted;
    await h.runDisconnect();
    respond(
      new globalThis.Response(
        JSON.stringify({ access_token: 'replacement-token', expires_in: 3600 }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    );
    assert.equal(await refresh, null);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: h.userId } });
    assert.equal(user.googleCalendarConnected, false);
    assert.equal(user.googleCalendarAccessToken, null);
    assert.equal(user.googleCalendarRefreshToken, null);
  } finally {
    if (originalId === undefined) delete process.env.GOOGLE_CLIENT_ID;
    else process.env.GOOGLE_CLIENT_ID = originalId;
    if (originalSecret === undefined) delete process.env.GOOGLE_CLIENT_SECRET;
    else process.env.GOOGLE_CLIENT_SECRET = originalSecret;
  }
});

test('disconnect calls Google revoke endpoint with decrypted token', async () => {
  const user = await prisma.user.create({
    data: {
      email: `calendar-disconnect-revoke-${randomUUID()}@example.test`,
      name: 'Disconnect revoke fixture',
      googleCalendarConnected: true,
      googleCalendarAccessToken: encryptToken('test-access-token-to-revoke'),
      googleCalendarRefreshToken: encryptToken('test-refresh-token-to-revoke'),
    },
  });
  users.push(user.id);

  let revokedUrl = '';
  let revokeMethod = '';
  let contentType = '';
  mock.method(globalThis, 'fetch', async (input: unknown, init?: any) => {
    revokedUrl = String(input);
    revokeMethod = init?.method || '';
    const headers = init?.headers as Record<string, string> | undefined;
    contentType = headers?.['Content-Type'] || '';
    return new globalThis.Response('{}', { status: 200 });
  });

  const payloads: unknown[] = [];
  const response = {
    json: (value: unknown) => {
      payloads.push(value);
      return response;
    },
  } as unknown as Response;

  await disconnect({ userId: user.id } as Request, response);

  assert.equal(revokedUrl, 'https://oauth2.googleapis.com/revoke?token=test-refresh-token-to-revoke');
  assert.equal(revokeMethod, 'POST');
  assert.equal(contentType, 'application/x-www-form-urlencoded');
  assert.deepEqual(payloads, [{ success: true, data: { connected: false, connectionId: null } }]);

  const updatedUser = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
  assert.equal(updatedUser.googleCalendarConnected, false);
  assert.equal(updatedUser.googleCalendarRefreshToken, null);
  assert.equal(updatedUser.googleCalendarAccessToken, null);
});

test('disconnect proceeds successfully even if Google revoke endpoint throws error', async () => {
  const user = await prisma.user.create({
    data: {
      email: `calendar-disconnect-fail-${randomUUID()}@example.test`,
      name: 'Disconnect fail fixture',
      googleCalendarConnected: true,
      googleCalendarRefreshToken: 'unencrypted-token-to-revoke',
    },
  });
  users.push(user.id);

  mock.method(globalThis, 'fetch', async () => {
    throw new Error('Network failure');
  });

  const payloads: unknown[] = [];
  const response = {
    json: (value: unknown) => {
      payloads.push(value);
      return response;
    },
  } as unknown as Response;

  await disconnect({ userId: user.id } as Request, response);

  const updatedUser = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
  assert.equal(updatedUser.googleCalendarConnected, false);
  assert.equal(updatedUser.googleCalendarRefreshToken, null);
  assert.deepEqual(payloads, [{ success: true, data: { connected: false, connectionId: null } }]);
});

test('disconnect aborts and does not revoke if expectedConnection mismatches current connection', async () => {
  const user = await prisma.user.create({
    data: {
      email: `calendar-disconnect-mismatch-${randomUUID()}@example.test`,
      name: 'Disconnect mismatch fixture',
      googleCalendarConnected: true,
      googleCalendarConnectionId: 'valid-current-conn-id',
      googleCalendarRefreshToken: 'active-refresh-token',
    },
  });
  users.push(user.id);

  let fetchCalled = false;
  mock.method(globalThis, 'fetch', async () => {
    fetchCalled = true;
    return new globalThis.Response('{}', { status: 200 });
  });

  const response = {
    json: () => response,
  } as unknown as Response;

  const req = {
    userId: user.id,
    get: (header: string) => (header.toLowerCase() === 'x-calendar-connection-id' ? 'stale-connection-id' : undefined),
  } as unknown as Request;

  await assert.rejects(
    () => disconnect(req, response),
    (err: any) => err.code === 409,
  );

  assert.equal(fetchCalled, false, 'Fetch to revoke endpoint should not have been called');

  const stillConnectedUser = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
  assert.equal(stillConnectedUser.googleCalendarConnected, true);
  assert.equal(stillConnectedUser.googleCalendarRefreshToken, 'active-refresh-token');
});
