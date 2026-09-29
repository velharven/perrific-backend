import type { Request } from 'express';
import { prisma } from './prisma';

export class CalendarSyncError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

// Upgrade an existing credential only after Google verifies its stable account identity.
export async function currentConnectionId(userId: string): Promise<string | null> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user?.googleCalendarConnected) return null;
  if (user.googleCalendarConnectionId) return user.googleCalendarConnectionId;
  let accessToken = user.googleCalendarAccessToken;
  if (
    (!accessToken ||
      (user.googleCalendarTokenExpiresAt &&
        user.googleCalendarTokenExpiresAt.getTime() - Date.now() < 300000)) &&
    user.googleCalendarRefreshToken
  ) {
    const { refreshGoogleAccessToken } = await import('./googleCalendarClient');
    accessToken =
      (await refreshGoogleAccessToken(userId, user.googleCalendarRefreshToken)) || accessToken;
    const latest = await prisma.user.findUnique({ where: { id: userId } });
    if (!latest?.googleCalendarConnected) return null;
    if (latest.googleCalendarConnectionId) return latest.googleCalendarConnectionId;
    if (latest.googleCalendarAccessToken !== accessToken) return currentConnectionId(userId);
  }
  if (!accessToken) return null;
  const response = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok)
    throw new CalendarSyncError(
      403,
      'Hubungkan ulang akun Google untuk memverifikasi pemilik kalender.',
    );
  const profile = (await response.json()) as { sub?: string; email?: string };
  if (!profile.sub) throw new CalendarSyncError(403, 'Identitas akun Google tidak tersedia.');
  const connection = await prisma.googleCalendarConnection.upsert({
    where: {
      userId_googleSubject_calendarId: {
        userId,
        googleSubject: profile.sub,
        calendarId: 'primary',
      },
    },
    create: { userId, googleSubject: profile.sub, email: profile.email },
    update: { email: profile.email },
  });
  const saved = await prisma.user.updateMany({
    where: {
      id: userId,
      googleCalendarConnected: true,
      googleCalendarConnectionId: null,
      googleCalendarAccessToken: accessToken,
    },
    data: { googleCalendarConnectionId: connection.id },
  });
  if (!saved.count) return currentConnectionId(userId);
  return connection.id;
}

export async function assertConnection(userId: string, expected?: string | null) {
  const id = await currentConnectionId(userId);
  if (expected !== undefined && (expected || null) !== id)
    throw new CalendarSyncError(409, 'Akun Google telah berubah. Muat ulang kalender.');
  return id;
}

export function expectedConnection(req: Request) {
  const value = req.get?.('X-Calendar-Connection-Id');
  return value === undefined ? undefined : value || null;
}

export function calendarActivityScope(connectionId: string | null) {
  return {
    OR: [
      ...(connectionId ? [{ calendarConnectionId: connectionId }] : []),
      { calendarConnectionId: null, googleEventId: null },
    ],
  };
}
