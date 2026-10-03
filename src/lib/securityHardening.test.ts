import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, mock, test } from 'node:test';
import type { Request, Response } from 'express';
import { connect } from '../controllers/googleCalendarController';
import { errorHandler } from '../middleware/errorHandler';
import { prisma } from './prisma';
import { env } from '../config/env';

const users: string[] = [];
afterEach(async () => {
  mock.restoreAll();
  for (const id of users.splice(0)) {
    await prisma.user.deleteMany({ where: { id } });
  }
});
after(() => prisma.$disconnect());

test('connect rejects access token when aud does not match env.googleClientId (confused deputy protection)', async () => {
  const user = await prisma.user.create({
    data: {
      email: `confused-deputy-${randomUUID()}@example.test`,
      name: 'Confused Deputy Victim',
    },
  });
  users.push(user.id);

  const originalClientId = env.googleClientId;
  (env as { googleClientId: string }).googleClientId = 'correct-purrific-client-id.apps.googleusercontent.com';

  mock.method(globalThis, 'fetch', async (url: unknown) => {
    const urlStr = String(url);
    if (urlStr.includes('tokeninfo')) {
      return new globalThis.Response(
        JSON.stringify({
          aud: 'attacker-client-id.apps.googleusercontent.com',
          email: user.email,
        }),
        { status: 200 },
      );
    }
    assert.fail(`Unexpected fetch call: ${urlStr}`);
  });

  let statusCode = 200;
  let responseBody: unknown = null;
  const res = {
    status: (code: number) => {
      statusCode = code;
      return res;
    },
    json: (data: unknown) => {
      responseBody = data;
      return res;
    },
  } as unknown as Response;

  const req = {
    userId: user.id,
    body: {
      accessToken: 'attacker-stolen-token',
    },
  } as unknown as Request;

  try {
    await connect(req, res);
    assert.equal(statusCode, 401);
    assert.deepEqual(responseBody, {
      success: false,
      message: 'Token Google tidak ditujukan untuk aplikasi ini.',
    });
  } finally {
    (env as { googleClientId: string }).googleClientId = originalClientId;
  }
});

test('connect rejects access token when issued_to/azp does not match env.googleClientId', async () => {
  const user = await prisma.user.create({
    data: {
      email: `issued-to-mismatch-${randomUUID()}@example.test`,
      name: 'Issued To Mismatch Victim',
    },
  });
  users.push(user.id);

  const originalClientId = env.googleClientId;
  (env as { googleClientId: string }).googleClientId = 'correct-purrific-client-id.apps.googleusercontent.com';

  mock.method(globalThis, 'fetch', async (url: unknown) => {
    const urlStr = String(url);
    if (urlStr.includes('tokeninfo')) {
      return new globalThis.Response(
        JSON.stringify({
          issued_to: 'attacker-client-id.apps.googleusercontent.com',
          email: user.email,
        }),
        { status: 200 },
      );
    }
    assert.fail(`Unexpected fetch call: ${urlStr}`);
  });

  let statusCode = 200;
  let responseBody: any = null;
  const res = {
    status: (code: number) => {
      statusCode = code;
      return res;
    },
    json: (data: any) => {
      responseBody = data;
      return res;
    },
  } as unknown as Response;

  const req = {
    userId: user.id,
    body: {
      accessToken: 'attacker-issued-to-token',
    },
  } as unknown as Request;

  try {
    await connect(req, res);
    assert.equal(statusCode, 401);
    assert.deepEqual(responseBody, {
      success: false,
      message: 'Token Google tidak ditujukan untuk aplikasi ini.',
    });
  } finally {
    (env as { googleClientId: string }).googleClientId = originalClientId;
  }
});

test('connect accepts access token when aud matches env.googleClientId', async () => {
  const user = await prisma.user.create({
    data: {
      email: `valid-aud-${randomUUID()}@example.test`,
      name: 'Valid Audience User',
    },
  });
  users.push(user.id);

  const originalClientId = env.googleClientId;
  (env as { googleClientId: string }).googleClientId = 'correct-purrific-client-id.apps.googleusercontent.com';

  mock.method(globalThis, 'fetch', async (url: unknown) => {
    const urlStr = String(url);
    if (urlStr.includes('tokeninfo')) {
      return new globalThis.Response(
        JSON.stringify({
          aud: 'correct-purrific-client-id.apps.googleusercontent.com',
          email: user.email,
        }),
        { status: 200 },
      );
    }
    if (urlStr.includes('userinfo')) {
      return new globalThis.Response(
        JSON.stringify({
          sub: `subject-${user.id}`,
          email: user.email,
          name: 'Valid Audience User',
        }),
        { status: 200 },
      );
    }
    assert.fail(`Unexpected fetch call: ${urlStr}`);
  });

  let statusCode = 200;
  let responseBody: any = null;
  const res = {
    status: (code: number) => {
      statusCode = code;
      return res;
    },
    json: (data: any) => {
      responseBody = data;
      return res;
    },
  } as unknown as Response;

  const req = {
    userId: user.id,
    body: {
      accessToken: 'valid-token',
    },
  } as unknown as Request;

  try {
    await connect(req, res);
    assert.equal(statusCode, 200);
    assert.equal(responseBody?.success, true);
  } finally {
    (env as { googleClientId: string }).googleClientId = originalClientId;
  }
});

test('errorHandler sanitizes 500 error messages when nodeEnv is production', () => {
  const originalNodeEnv = env.nodeEnv;
  (env as { nodeEnv: string }).nodeEnv = 'production';

  let statusCode = 200;
  let responseBody: unknown = null;
  const res = {
    status: (code: number) => {
      statusCode = code;
      return res;
    },
    json: (data: unknown) => {
      responseBody = data;
      return res;
    },
  } as unknown as Response;

  try {
    errorHandler(new Error('Sensitive database credentials leak!'), {} as Request, res, () => {});
    assert.equal(statusCode, 500);
    assert.deepEqual(responseBody, {
      success: false,
      message: 'Terjadi kesalahan internal pada server',
    });
  } finally {
    (env as { nodeEnv: string }).nodeEnv = originalNodeEnv;
  }
});

test('errorHandler displays error details when nodeEnv is development', () => {
  const originalNodeEnv = env.nodeEnv;
  (env as { nodeEnv: string }).nodeEnv = 'development';

  let statusCode = 200;
  let responseBody: unknown = null;
  const res = {
    status: (code: number) => {
      statusCode = code;
      return res;
    },
    json: (data: unknown) => {
      responseBody = data;
      return res;
    },
  } as unknown as Response;

  try {
    errorHandler(new Error('Explicit dev debug error'), {} as Request, res, () => {});
    assert.equal(statusCode, 500);
    assert.deepEqual(responseBody, {
      success: false,
      message: 'Explicit dev debug error',
    });
  } finally {
    (env as { nodeEnv: string }).nodeEnv = originalNodeEnv;
  }
});
