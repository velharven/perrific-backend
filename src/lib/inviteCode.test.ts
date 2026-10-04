import test from 'node:test';
import assert from 'node:assert/strict';
import {
  randomInviteCode,
  encryptInviteCode,
  decryptInviteCode,
} from './inviteCode';
import { prisma } from './prisma';
import { joinTeam } from '../controllers/teamController';

test('randomInviteCode generates uppercase alphanumeric codes of specified length', () => {
  const code = randomInviteCode(12);
  assert.equal(code.length, 12);
  assert.match(code, /^[A-Z2-9]+$/);
});

test('encryptInviteCode and decryptInviteCode round-trip correctly', () => {
  const code = 'ABCDEF234567';
  const token = encryptInviteCode(code);

  assert.notEqual(token, code);
  // Ensure token is URL-safe base64url without +, /, or =
  assert.match(token, /^[A-Za-z0-9_-]+$/);

  const decrypted = decryptInviteCode(token);
  assert.equal(decrypted, code);
});

test('decryptInviteCode transparently returns plain unencrypted invite codes', () => {
  const plain = 'ABCDEF123456';
  const result = decryptInviteCode(plain);
  assert.equal(result, plain);
});

test('decryptInviteCode handles malformed tokens without throwing uncaught exceptions', () => {
  assert.equal(decryptInviteCode(''), '');
  assert.equal(decryptInviteCode('invalid-base64url-!!@@##'), 'invalid-base64url-!!@@##');
  // Random base64url that is not v1 format
  const randomB64 = Buffer.from('hello-world-not-encrypted').toString('base64url');
  assert.equal(decryptInviteCode(randomB64), randomB64);
});

test('joinTeam accepts encrypted invite token and creates pending join request', async () => {
  const admin = await prisma.user.create({
    data: { email: `admin-${Date.now()}@example.com`, name: 'Admin User' },
  });
  const member = await prisma.user.create({
    data: { email: `member-${Date.now()}@example.com`, name: 'Member Requester' },
  });
  const inviteCode = `TEST${Date.now().toString(36).slice(-8).toUpperCase()}`;
  const team = await prisma.team.create({
    data: {
      name: `Team Encrypted ${Date.now()}`,
      inviteCode,
      members: { create: { userId: admin.id, role: 'ADMIN' } },
    },
  });

  try {
    const encryptedToken = encryptInviteCode(inviteCode);
    let statusCode = 200;
    let jsonResult: any = null;
    const req: any = {
      userId: member.id,
      body: { code: encryptedToken },
    };
    const res: any = {
      status(code: number) { statusCode = code; return this; },
      json(data: any) { jsonResult = data; return this; },
    };

    await joinTeam(req, res);

    assert.equal(statusCode, 201);
    assert.equal(jsonResult?.success, true);
    assert.equal(jsonResult?.data?.teamId, team.id);

    // Verify in database
    const reqInDb = await prisma.teamJoinRequest.findFirst({
      where: { teamId: team.id, userId: member.id },
    });
    assert.equal(reqInDb?.status, 'PENDING');
  } finally {
    await prisma.teamJoinRequest.deleteMany({ where: { teamId: team.id } });
    await prisma.teamMember.deleteMany({ where: { teamId: team.id } });
    await prisma.team.deleteMany({ where: { id: team.id } });
    await prisma.user.deleteMany({ where: { id: { in: [admin.id, member.id] } } });
  }
});
