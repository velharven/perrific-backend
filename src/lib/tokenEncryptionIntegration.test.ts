import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, mock, test } from 'node:test';
import type { Request, Response } from 'express';
import { prisma } from './prisma';
import { encryptToken, decryptToken, isEncryptedToken } from './crypto';
import { getValidUserToken, refreshGoogleAccessToken } from './googleCalendarClient';
import { currentConnectionId } from './calendarConnection';
import { connect } from '../controllers/googleCalendarController';
import { migrateTokensToEncrypted } from './tokenMigration';

const testUsers: string[] = [];

afterEach(async () => {
  mock.restoreAll();
  for (const id of testUsers.splice(0)) {
    await prisma.user.deleteMany({ where: { id } });
  }
});

after(() => prisma.$disconnect());

test('getValidUserToken decrypts encrypted tokens and returns plaintext', async () => {
  const plainAccess = 'ya29.access-token-encrypted-test';
  const plainRefresh = '1//refresh-token-encrypted-test';
  const encryptedAccess = encryptToken(plainAccess);
  const encryptedRefresh = encryptToken(plainRefresh);

  const user = await prisma.user.create({
    data: {
      email: `test-enc-${randomUUID()}@example.test`,
      name: 'Encrypted User',
      googleCalendarConnected: true,
      googleCalendarConnectionId: 'conn-1',
      googleCalendarAccessToken: encryptedAccess,
      googleCalendarRefreshToken: encryptedRefresh,
      googleCalendarTokenExpiresAt: new Date(Date.now() + 3600000),
    },
  });
  testUsers.push(user.id);

  const result = await getValidUserToken(user.id);
  assert.ok('accessToken' in result);
  assert.equal(result.accessToken, plainAccess);
  assert.equal(result.connectionId, 'conn-1');
});

test('getValidUserToken lazily upgrades legacy plaintext tokens to encrypted', async () => {
  const legacyAccess = 'ya29.legacy-plaintext-access';
  const legacyRefresh = '1//legacy-plaintext-refresh';

  const user = await prisma.user.create({
    data: {
      email: `test-lazy-${randomUUID()}@example.test`,
      name: 'Lazy User',
      googleCalendarConnected: true,
      googleCalendarConnectionId: 'conn-lazy',
      googleCalendarAccessToken: legacyAccess,
      googleCalendarRefreshToken: legacyRefresh,
      googleCalendarTokenExpiresAt: new Date(Date.now() + 3600000),
    },
  });
  testUsers.push(user.id);

  const result = await getValidUserToken(user.id);
  assert.ok('accessToken' in result);
  assert.equal(result.accessToken, legacyAccess);

  // Allow asynchronous lazy upgrade to complete
  await new Promise((resolve) => setTimeout(resolve, 50));

  const updatedUser = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
  assert.ok(isEncryptedToken(updatedUser.googleCalendarAccessToken));
  assert.ok(isEncryptedToken(updatedUser.googleCalendarRefreshToken));
  assert.equal(decryptToken(updatedUser.googleCalendarAccessToken), legacyAccess);
  assert.equal(decryptToken(updatedUser.googleCalendarRefreshToken), legacyRefresh);
});

test('refreshGoogleAccessToken encrypts new access token in database and accepts encrypted refresh token', async () => {
  const plainRefresh = '1//plain-refresh-for-refresh-test';
  const encryptedRefresh = encryptToken(plainRefresh);

  const user = await prisma.user.create({
    data: {
      email: `test-refresh-${randomUUID()}@example.test`,
      name: 'Refresh Test User',
      googleCalendarConnected: true,
      googleCalendarConnectionId: 'conn-refresh',
      googleCalendarAccessToken: null,
      googleCalendarRefreshToken: encryptedRefresh,
    },
  });
  testUsers.push(user.id);

  const originalId = process.env.GOOGLE_CLIENT_ID;
  const originalSecret = process.env.GOOGLE_CLIENT_SECRET;
  process.env.GOOGLE_CLIENT_ID = 'test-client-id';
  process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';

  mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    // Verify Google received the decrypted refresh token
    const bodyStr = String(init?.body || '');
    assert.ok(bodyStr.includes(encodeURIComponent(plainRefresh)) || bodyStr.includes(plainRefresh));
    return new globalThis.Response(
      JSON.stringify({
        access_token: 'ya29.new-fresh-access-token',
        expires_in: 3600,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  });

  try {
    const refreshed = await refreshGoogleAccessToken(user.id, encryptedRefresh);
    assert.equal(refreshed, 'ya29.new-fresh-access-token');

    const updatedUser = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    assert.ok(isEncryptedToken(updatedUser.googleCalendarAccessToken));
    assert.equal(decryptToken(updatedUser.googleCalendarAccessToken), 'ya29.new-fresh-access-token');
  } finally {
    if (originalId === undefined) delete process.env.GOOGLE_CLIENT_ID;
    else process.env.GOOGLE_CLIENT_ID = originalId;
    if (originalSecret === undefined) delete process.env.GOOGLE_CLIENT_SECRET;
    else process.env.GOOGLE_CLIENT_SECRET = originalSecret;
  }
});

test('connect controller action stores encrypted access and refresh tokens', async () => {
  const user = await prisma.user.create({
    data: {
      email: `test-connect-${randomUUID()}@example.test`,
      name: 'Connect User',
    },
  });
  testUsers.push(user.id);

  const plainAccess = 'ya29.test-connect-access';
  const plainRefresh = '1//test-connect-refresh';

  mock.method(globalThis, 'fetch', async (url: unknown) => {
    const urlStr = String(url);
    if (urlStr.includes('tokeninfo')) {
      return new globalThis.Response(JSON.stringify({ email: user.email }), { status: 200 });
    }
    if (urlStr.includes('userinfo')) {
      return new globalThis.Response(
        JSON.stringify({
          sub: `subject-${user.id}`,
          email: user.email,
          name: 'Connect User',
        }),
        { status: 200 },
      );
    }
    assert.fail(`Unexpected fetch call to ${urlStr}`);
  });

  const responseJson: unknown[] = [];
  const res = {
    status: () => res,
    json: (data: unknown) => {
      responseJson.push(data);
      return res;
    },
  } as unknown as Response;

  const req = {
    userId: user.id,
    body: {
      accessToken: plainAccess,
    },
  } as unknown as Request;

  // We set an existing refresh token first to test finalRefreshToken preservation
  await prisma.user.update({
    where: { id: user.id },
    data: {
      googleCalendarRefreshToken: plainRefresh,
    },
  });

  await connect(req, res);

  const updatedUser = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
  assert.equal(updatedUser.googleCalendarConnected, true);
  assert.ok(isEncryptedToken(updatedUser.googleCalendarAccessToken));
  assert.equal(decryptToken(updatedUser.googleCalendarAccessToken), plainAccess);
});

test('migrateTokensToEncrypted encrypts existing unencrypted tokens and skips already encrypted ones', async () => {
  const legacyAccess = 'ya29.unmigrated-access';
  const legacyRefresh = '1//unmigrated-refresh';
  const alreadyEncrypted = encryptToken('ya29.already-encrypted');

  const u1 = await prisma.user.create({
    data: {
      email: `test-mig1-${randomUUID()}@example.test`,
      name: 'Migration User 1',
      googleCalendarConnected: true,
      googleCalendarAccessToken: legacyAccess,
      googleCalendarRefreshToken: legacyRefresh,
    },
  });
  testUsers.push(u1.id);

  const u2 = await prisma.user.create({
    data: {
      email: `test-mig2-${randomUUID()}@example.test`,
      name: 'Migration User 2',
      googleCalendarConnected: true,
      googleCalendarAccessToken: alreadyEncrypted,
      googleCalendarRefreshToken: null,
    },
  });
  testUsers.push(u2.id);

  const result = await migrateTokensToEncrypted(prisma);
  assert.ok(result.migratedCount >= 1);

  const refreshedU1 = await prisma.user.findUniqueOrThrow({ where: { id: u1.id } });
  assert.ok(isEncryptedToken(refreshedU1.googleCalendarAccessToken));
  assert.ok(isEncryptedToken(refreshedU1.googleCalendarRefreshToken));
  assert.equal(decryptToken(refreshedU1.googleCalendarAccessToken), legacyAccess);
  assert.equal(decryptToken(refreshedU1.googleCalendarRefreshToken), legacyRefresh);

  const refreshedU2 = await prisma.user.findUniqueOrThrow({ where: { id: u2.id } });
  assert.equal(refreshedU2.googleCalendarAccessToken, alreadyEncrypted);
});

test('getValidUserToken returns 403 when decryptToken fails due to corrupted ciphertext', async () => {
  // Create user with invalid v1 token (corrupted ciphertext/authTag)
  const corruptedToken = 'v1:0123456789abcdef01234567:0123456789abcdef0123456789abcdef:deadbeef';
  const user = await prisma.user.create({
    data: {
      email: `test-corrupt-${randomUUID()}@example.test`,
      name: 'Corrupt User',
      googleCalendarConnected: true,
      googleCalendarAccessToken: corruptedToken,
      googleCalendarRefreshToken: 'test-refresh',
    },
  });
  testUsers.push(user.id);

  const result = await getValidUserToken(user.id);
  assert.ok('error' in result);
  assert.equal(result.code, 403);
  assert.equal(
    result.error,
    'Sesi Google Calendar telah kedaluwarsa atau kunci enkripsi berubah. Silakan hubungkan ulang.',
  );
});

test('getValidUserToken lazy upgrade skips expired access token but upgrades refresh token', async () => {
  const legacyAccess = 'ya29.expired-access';
  const legacyRefresh = '1//unencrypted-refresh';

  const user = await prisma.user.create({
    data: {
      email: `test-exp-${randomUUID()}@example.test`,
      name: 'Expired User',
      googleCalendarConnected: true,
      googleCalendarConnectionId: 'conn-exp',
      googleCalendarAccessToken: legacyAccess,
      googleCalendarRefreshToken: legacyRefresh,
      // Already expired 1 hour ago
      googleCalendarTokenExpiresAt: new Date(Date.now() - 3600000),
    },
  });
  testUsers.push(user.id);

  // Mock refresh fetch
  const originalId = process.env.GOOGLE_CLIENT_ID;
  const originalSecret = process.env.GOOGLE_CLIENT_SECRET;
  process.env.GOOGLE_CLIENT_ID = 'test-client-id';
  process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';

  mock.method(globalThis, 'fetch', async () => {
    return new globalThis.Response(
      JSON.stringify({
        access_token: 'ya29.refreshed-new-token',
        expires_in: 3600,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  });

  try {
    const result = await getValidUserToken(user.id);
    assert.ok('accessToken' in result);
    assert.equal(result.accessToken, 'ya29.refreshed-new-token');

    // Allow background updates to finish
    await new Promise((resolve) => setTimeout(resolve, 50));

    const updatedUser = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    // Access token was refreshed and saved encrypted
    assert.ok(isEncryptedToken(updatedUser.googleCalendarAccessToken));
    assert.equal(decryptToken(updatedUser.googleCalendarAccessToken), 'ya29.refreshed-new-token');
    // Refresh token was lazy-upgraded to encrypted
    assert.ok(isEncryptedToken(updatedUser.googleCalendarRefreshToken));
    assert.equal(decryptToken(updatedUser.googleCalendarRefreshToken), legacyRefresh);
  } finally {
    if (originalId === undefined) delete process.env.GOOGLE_CLIENT_ID;
    else process.env.GOOGLE_CLIENT_ID = originalId;
    if (originalSecret === undefined) delete process.env.GOOGLE_CLIENT_SECRET;
    else process.env.GOOGLE_CLIENT_SECRET = originalSecret;
  }
});

test('currentConnectionId successfully resolves and upgrades with encrypted access token', async () => {
  const plainAccess = 'ya29.encrypted-conn-id-access';
  const encryptedAccess = encryptToken(plainAccess);

  const user = await prisma.user.create({
    data: {
      email: `test-connid-${randomUUID()}@example.test`,
      name: 'ConnId User',
      googleCalendarConnected: true,
      googleCalendarConnectionId: null, // Legacy state needing upgrade
      googleCalendarAccessToken: encryptedAccess,
      googleCalendarRefreshToken: null,
      googleCalendarTokenExpiresAt: new Date(Date.now() + 3600000),
    },
  });
  testUsers.push(user.id);

  mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    // Verify Google received the decrypted Bearer token
    assert.equal((init?.headers as Record<string, string>)?.Authorization, `Bearer ${plainAccess}`);
    return new globalThis.Response(
      JSON.stringify({
        sub: `subject-connid-${user.id}`,
        email: user.email,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  });

  const connectionId = await currentConnectionId(user.id);
  assert.ok(connectionId);

  const updatedUser = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
  assert.equal(updatedUser.googleCalendarConnectionId, connectionId);
});

test('refreshAccessToken on invalid_grant does not disconnect user if refresh token was replaced concurrently', async () => {
  const oldPlainRefresh = '1//old-refresh-token';
  const newPlainRefresh = '1//new-concurrent-refresh-token';

  const user = await prisma.user.create({
    data: {
      email: `test-invgrant-${randomUUID()}@example.test`,
      name: 'InvalidGrant User',
      googleCalendarConnected: true,
      googleCalendarRefreshToken: encryptToken(oldPlainRefresh),
    },
  });
  testUsers.push(user.id);

  const originalId = process.env.GOOGLE_CLIENT_ID;
  const originalSecret = process.env.GOOGLE_CLIENT_SECRET;
  process.env.GOOGLE_CLIENT_ID = 'test-client-id';
  process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';

  let respondGoogle!: (res: globalThis.Response) => void;
  const requestTriggered = new Promise<void>((resolve) => {
    mock.method(globalThis, 'fetch', async () => {
      resolve();
      return new Promise<globalThis.Response>((res) => {
        respondGoogle = res;
      });
    });
  });

  try {
    const refreshPromise = refreshGoogleAccessToken(user.id, oldPlainRefresh);
    await requestTriggered;

    // Simulate user reconnecting with new refresh token concurrently
    await prisma.user.update({
      where: { id: user.id },
      data: {
        googleCalendarRefreshToken: encryptToken(newPlainRefresh),
      },
    });

    // Google responds with invalid_grant for old token
    respondGoogle(
      new globalThis.Response('invalid_grant: Token has been expired or revoked.', {
        status: 400,
        headers: { 'Content-Type': 'text/plain' },
      }),
    );

    const result = await refreshPromise;
    assert.equal(result, null);

    // User must STILL be connected because refresh token was replaced!
    const updatedUser = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    assert.equal(updatedUser.googleCalendarConnected, true);
    assert.equal(decryptToken(updatedUser.googleCalendarRefreshToken), newPlainRefresh);
  } finally {
    if (originalId === undefined) delete process.env.GOOGLE_CLIENT_ID;
    else process.env.GOOGLE_CLIENT_ID = originalId;
    if (originalSecret === undefined) delete process.env.GOOGLE_CLIENT_SECRET;
    else process.env.GOOGLE_CLIENT_SECRET = originalSecret;
  }
});

