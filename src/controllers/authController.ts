import type { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { signToken } from '../lib/jwt';
import { sendError } from '../lib/errors';
import { env } from '../config/env';
import { verifyGoogleAccessToken } from '../lib/googleAuth';

const USERNAME_RE = /^[a-z0-9_.]{3,30}$/;

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
  name: z.string().min(1),
  username: z.string().trim().min(3).max(30).regex(USERNAME_RE, 'Username tidak valid'),
});

export async function register(req: Request, res: Response) {
  const body = registerSchema.parse(req.body);
  const existing = await prisma.user.findUnique({ where: { email: body.email } });
  if (existing) return sendError(res, 409, 'Email sudah terdaftar');
  const usernameTaken = await prisma.user.findUnique({ where: { username: body.username } });
  if (usernameTaken) return sendError(res, 409, 'Username sudah dipakai');

  const passwordHash = await bcrypt.hash(body.password, env.bcryptRounds);
  const user = await prisma.user.create({
    data: { email: body.email, name: body.name, username: body.username, passwordHash },
    select: userSelect,
  });

  const token = signToken({ userId: user.id });
  return res.status(201).json({ success: true, data: { user: toPublicUser(user), token } });
}

const loginSchema = z.object({
  identifier: z.string().trim().min(1),
  password: z.string().min(1),
});

export async function login(req: Request, res: Response) {
  const body = loginSchema.parse(req.body);
  const user = body.identifier.includes('@')
    ? await prisma.user.findUnique({ where: { email: body.identifier } })
    : await prisma.user.findUnique({ where: { username: body.identifier.toLowerCase() } });
  if (!user) return sendError(res, 401, 'Email/username atau password salah');
  if (!user.passwordHash) {
    return sendError(res, 401, 'Akun ini memakai login Google, silakan masuk dengan Google');
  }

  const valid = await bcrypt.compare(body.password, user.passwordHash);
  if (!valid) return sendError(res, 401, 'Email/username atau password salah');

  const token = signToken({ userId: user.id });
  return res.json({
    success: true,
    data: { token, user: toPublicUser(user) },
  });
}

const googleLoginSchema = z.object({
  accessToken: z.string().min(1),
});

export async function googleLogin(req: Request, res: Response) {
  const body = googleLoginSchema.parse(req.body);

  let profile;
  try {
    profile = await verifyGoogleAccessToken(body.accessToken);
  } catch {
    return sendError(res, 401, 'Login Google gagal, token tidak valid');
  }

  const byGoogleId = await prisma.user.findUnique({ where: { googleId: profile.googleId } });
  if (byGoogleId) {
    // Sync avatar dari Google jika berubah / sebelumnya kosong.
    // Ini yang menyebabkan "di laptop lain muncul, di laptop ini tidak":
    // user lama bisa punya avatarUrl null dan tidak pernah ter-update.
    // Google picture (lh3.googleusercontent.com) juga butuh refresh berkala.
    // Jangan timpa foto custom (data:image/...) yang di-upload user di /settings.
    const current = byGoogleId.avatarUrl;
    const isCustomDataUrl = current?.startsWith('data:image/');
    const shouldSyncAvatar =
      profile.avatarUrl &&
      profile.avatarUrl !== current &&
      !isCustomDataUrl;
    if (shouldSyncAvatar) {
      const updated = await prisma.user.update({
        where: { id: byGoogleId.id },
        data: { avatarUrl: profile.avatarUrl },
        select: userSelect,
      });
      const token = signToken({ userId: updated.id });
      return res.json({
        success: true,
        data: { token, user: toPublicUser(updated) },
      });
    }
    const token = signToken({ userId: byGoogleId.id });
    return res.json({
      success: true,
      data: { token, user: toPublicUser(byGoogleId) },
    });
  }

  const byEmail = await prisma.user.findUnique({ where: { email: profile.email } });
  if (byEmail) {
    return sendError(res, 409, 'Email ini sudah terdaftar, silakan masuk dengan password');
  }

  const user = await prisma.user.create({
    data: {
      email: profile.email,
      name: profile.name,
      passwordHash: null,
      googleId: profile.googleId,
      avatarUrl: profile.avatarUrl,
    },
    select: userSelect,
  });

  const token = signToken({ userId: user.id });
  return res.status(201).json({ success: true, data: { user: toPublicUser(user), token } });
}

const userSelect = {
  id: true,
  email: true,
  name: true,
  username: true,
  avatarUrl: true,
  createdAt: true,
  passwordHash: true,
} as const;

function toPublicUser(user: {
  passwordHash: string | null;
  id: string;
  email: string;
  name: string;
  username: string | null;
  avatarUrl: string | null;
  createdAt: Date;
}) {
  const { passwordHash, ...rest } = user;
  return { ...rest, hasPassword: !!passwordHash };
}

export async function me(req: Request, res: Response) {
  const user = await prisma.user.findUnique({
    where: { id: req.userId },
    select: userSelect,
  });
  if (!user) return sendError(res, 404, 'Pengguna tidak ditemukan');
  return res.json({ success: true, data: toPublicUser(user) });
}

const AVATAR_RE = /^(https?:\/\/|data:image\/(png|jpeg|webp);base64,)/;

const updateMeSchema = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  username: z.string().trim().max(30).nullable().optional(),
  avatarUrl: z.string().max(300000).nullable().optional(),
});

export async function updateMe(req: Request, res: Response) {
  const body = updateMeSchema.parse(req.body);
  const data: { name?: string; username?: string | null; avatarUrl?: string | null } = {};

  if (body.name !== undefined) data.name = body.name;

  if (body.username !== undefined) {
    if (body.username === null || body.username === '') {
      data.username = null;
    } else {
      const username = body.username;
      if (!USERNAME_RE.test(username)) {
        return sendError(res, 422, 'Username 3–30 karakter huruf kecil saja: huruf kecil, angka, titik, underscore');
      }
      const taken = await prisma.user.findUnique({ where: { username } });
      if (taken && taken.id !== req.userId) {
        return sendError(res, 409, 'Username sudah dipakai');
      }
      data.username = username;
    }
  }

  if (body.avatarUrl !== undefined) {
    if (body.avatarUrl !== null && !AVATAR_RE.test(body.avatarUrl)) {
      return sendError(res, 422, 'URL avatar tidak valid');
    }
    data.avatarUrl = body.avatarUrl;
  }

  const user = await prisma.user.update({
    where: { id: req.userId },
    data,
    select: userSelect,
  });
  return res.json({ success: true, data: toPublicUser(user) });
}

const changePasswordSchema = z.object({
  currentPassword: z.string().optional(),
  newPassword: z.string().min(8).max(100),
});

export async function changePassword(req: Request, res: Response) {
  const body = changePasswordSchema.parse(req.body);
  const user = await prisma.user.findUnique({ where: { id: req.userId } });
  if (!user) return sendError(res, 404, 'Pengguna tidak ditemukan');

  if (user.passwordHash) {
    if (!body.currentPassword) {
      return sendError(res, 400, 'Password saat ini wajib diisi');
    }
    const valid = await bcrypt.compare(body.currentPassword, user.passwordHash);
    if (!valid) return sendError(res, 401, 'Password saat ini salah');
  }

  const passwordHash = await bcrypt.hash(body.newPassword, env.bcryptRounds);
  await prisma.user.update({ where: { id: req.userId }, data: { passwordHash } });
  return res.json({ success: true, data: { ok: true } });
}

export async function checkUsername(req: Request, res: Response) {
  const username = String(req.query.username ?? '').trim();
  if (!USERNAME_RE.test(username)) {
    return res.json({ success: true, data: { available: false } });
  }
  const existing = await prisma.user.findUnique({ where: { username } });
  const available = !existing || existing.id === req.userId;
  return res.json({ success: true, data: { available } });
}
