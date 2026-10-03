import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, mock, test } from 'node:test';
import type { Request, Response } from 'express';
import { prisma } from './prisma';
import { encryptToken, decryptToken, isEncryptedToken } from './crypto';
import { getValidUserToken, refreshGoogleAccessToken } from './googleCalendarClient';
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
