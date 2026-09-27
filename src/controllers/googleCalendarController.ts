import type { Request, Response } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { sendError } from '../lib/errors';
import { emitToUser } from '../lib/socket';
import { withUserCalendarLock } from '../lib/calendarOperationLock';

interface GoogleTokenInfo {
  aud?: string;
  sub?: string;
  email?: string;
  expires_in?: string;
}

interface GoogleUserInfo {
  email?: string;
  name?: string;
  picture?: string;
}

interface GoogleCalendarEventItem {
  id: string;
  summary?: string;
  description?: string;
  location?: string;
  htmlLink?: string;
  status?: string;
  recurrence?: string[];
  recurringEventId?: string;
  originalStartTime?: { dateTime?: string; date?: string };
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  colorId?: string;
}

class GoogleCalendarListError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

async function listGoogleEventItems(accessToken: string, timeMin: string, timeMax: string, maxResults: number) {
  const url = new URL('https://www.googleapis.com/calendar/v3/calendars/primary/events');
  url.searchParams.set('timeMin', timeMin);
  url.searchParams.set('timeMax', timeMax);
  url.searchParams.set('singleEvents', 'true');
  url.searchParams.set('showDeleted', 'true');
  url.searchParams.set('orderBy', 'startTime');
  url.searchParams.set('maxResults', String(maxResults));

  const items: GoogleCalendarEventItem[] = [];
  let pageToken: string | undefined;
  do {
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const response = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) {
      throw new GoogleCalendarListError(response.status, await response.text());
    }
    const page = (await response.json()) as {
      items?: GoogleCalendarEventItem[];
      nextPageToken?: string;
    };
    items.push(...(page.items ?? []));
    pageToken = page.nextPageToken;
  } while (pageToken);

  return items;
}

async function findRecurringInstanceForActivity(
  accessToken: string,
  parentId: string,
  date: Date,
  startTime: Date | null,
): Promise<GoogleCalendarEventItem | null> {
  const reference = startTime ?? date;
  const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(parentId)}/instances`);
  url.searchParams.set('timeMin', new Date(reference.getTime() - 2 * 86400000).toISOString());
  url.searchParams.set('timeMax', new Date(reference.getTime() + 2 * 86400000).toISOString());
  url.searchParams.set('showDeleted', 'true');
  url.searchParams.set('maxResults', '250');
  const instances: GoogleCalendarEventItem[] = [];
  let pageToken: string | undefined;
  do {
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const response = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) throw new GoogleCalendarListError(response.status, await response.text());
    const page = (await response.json()) as { items?: GoogleCalendarEventItem[]; nextPageToken?: string };
    instances.push(...(page.items ?? []));
    pageToken = page.nextPageToken;
  } while (pageToken);

  const maxDifference = startTime ? 60000 : 12 * 3600000;
  return instances
    .map((item) => ({
      item,
      difference: Math.abs(new Date(
        item.start?.dateTime || item.start?.date ||
        item.originalStartTime?.dateTime || item.originalStartTime?.date || '',
      ).getTime() - reference.getTime()),
    }))
    .filter(({ difference }) => Number.isFinite(difference) && difference <= maxDifference)
    .sort((a, b) => a.difference - b.difference)[0]?.item ?? null;
}

export async function refreshGoogleAccessToken(userId: string, refreshToken: string): Promise<string | null> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    console.error('[googleCalendar] GOOGLE_CLIENT_ID atau GOOGLE_CLIENT_SECRET tidak dikonfigurasi.');
    return null;
  }

  try {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error('[googleCalendar] refreshGoogleAccessToken gagal:', res.status, errText);
      if (errText.includes('invalid_grant')) {
        await prisma.user.update({
          where: { id: userId },
          data: {
            googleCalendarConnected: false,
            googleCalendarAccessToken: null,
            googleCalendarRefreshToken: null,
            googleCalendarTokenExpiresAt: null,
          },
        });
      }
      return null;
    }

    const data = (await res.json()) as { access_token: string; expires_in: number };
    const expiresAt = new Date(Date.now() + (data.expires_in || 3600) * 1000);

    await prisma.user.update({
      where: { id: userId },
      data: {
        googleCalendarConnected: true,
        googleCalendarAccessToken: data.access_token,
        googleCalendarTokenExpiresAt: expiresAt,
      },
    });

    return data.access_token;
  } catch (error) {
    console.error('[googleCalendar] Exception saat refreshGoogleAccessToken:', error);
    return null;
  }
}

async function getValidUserToken(userId: string): Promise<{ accessToken: string } | { error: string; code: number }> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      googleCalendarConnected: true,
      googleCalendarAccessToken: true,
      googleCalendarRefreshToken: true,
      googleCalendarTokenExpiresAt: true,
    },
  });

  if (!user || !user.googleCalendarConnected) {
    return { error: 'Google Calendar belum terhubung.', code: 400 };
  }

  // Cek apakah token sudah kedaluwarsa atau akan kedaluwarsa dalam 5 menit ke depan (300.000 ms)
  const isExpiredOrSoon =
    !user.googleCalendarAccessToken ||
    (user.googleCalendarTokenExpiresAt &&
      user.googleCalendarTokenExpiresAt.getTime() - Date.now() < 300_000);

  if (isExpiredOrSoon && user.googleCalendarRefreshToken) {
    const refreshedToken = await refreshGoogleAccessToken(userId, user.googleCalendarRefreshToken);
    if (refreshedToken) {
      return { accessToken: refreshedToken };
    }
  }

  if (!user.googleCalendarAccessToken) {
    return { error: 'Sesi Google Calendar telah kedaluwarsa. Silakan hubungkan ulang.', code: 403 };
  }

  return { accessToken: user.googleCalendarAccessToken };
}

// ============ Status ============
export async function getStatus(req: Request, res: Response) {
  if (!req.userId) return sendError(res, 401, 'Tidak terautentikasi');

  const user = await prisma.user.findUnique({
    where: { id: req.userId },
    select: {
      googleCalendarConnected: true,
      googleCalendarEmail: true,
      googleCalendarName: true,
      googleCalendarAvatarUrl: true,
      googleCalendarSyncedAt: true,
    },
  });

  if (!user) return sendError(res, 404, 'Pengguna tidak ditemukan');

  return res.json({
    success: true,
    data: {
      connected: user.googleCalendarConnected,
      email: user.googleCalendarEmail,
      name: user.googleCalendarName,
      avatarUrl: user.googleCalendarAvatarUrl,
      syncedAt: user.googleCalendarSyncedAt,
    },
  });
}

// ============ Connect ============
const connectSchema = z.object({
  code: z.string().min(1).optional(),
  accessToken: z.string().min(1).optional(),
  email: z.string().email().optional(),
});

export async function connect(req: Request, res: Response) {
  if (!req.userId) return sendError(res, 401, 'Tidak terautentikasi');
  const body = connectSchema.parse(req.body);

  let accessToken = body.accessToken;
  let refreshToken: string | null = null;
  let expiresAt: Date | null = null;

  if (body.code) {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      return sendError(res, 500, 'GOOGLE_CLIENT_ID atau GOOGLE_CLIENT_SECRET belum dikonfigurasi di server.');
    }

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: body.code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: 'postmessage',
        grant_type: 'authorization_code',
      }),
    });

    if (!tokenRes.ok) {
      const errText = await tokenRes.text();
      console.error('[googleCalendar] Gagal menukar authorization code:', errText);
      return sendError(res, 400, 'Gagal menukarkan kode otorisasi dengan Google.');
    }

    const tokenData = (await tokenRes.json()) as {
      access_token: string;
      expires_in?: number;
      refresh_token?: string;
    };

    accessToken = tokenData.access_token;
    refreshToken = tokenData.refresh_token || null;
    if (tokenData.expires_in) {
      expiresAt = new Date(Date.now() + tokenData.expires_in * 1000);
    }
  } else if (body.accessToken) {
    // Verifikasi access token ke Google tokeninfo (fallback implicit flow)
    const tokenInfoRes = await fetch(
      `https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(body.accessToken)}`,
    );

    if (!tokenInfoRes.ok) {
      return sendError(res, 400, 'Access token Google tidak valid atau sudah kedaluwarsa.');
    }

    const tokenInfo = (await tokenInfoRes.json()) as GoogleTokenInfo;
    if (!body.email && tokenInfo.email) {
      body.email = tokenInfo.email;
    }
  }

  if (!accessToken) {
    return sendError(res, 400, 'Access token atau authorization code diperlukan.');
  }

  // Ambil profil lengkap dari Google userinfo
  let email = body.email || null;
  let name: string | null = null;
  let picture: string | null = null;

  try {
    const userRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (userRes.ok) {
      const userInfo = (await userRes.json()) as GoogleUserInfo;
      email = userInfo.email || email;
      name = userInfo.name || null;
      picture = userInfo.picture || null;
    }
  } catch (err) {
    console.error('[googleCalendar] Gagal mengambil profil Google userinfo:', err);
  }

  // Jika Google tidak mengembalikan refresh_token baru (karena sebelumnya sudah diizinkan),
  // pertahankan refresh_token yang sudah ada di database jika ada
  let finalRefreshToken = refreshToken;
  if (!finalRefreshToken) {
    const existing = await prisma.user.findUnique({
      where: { id: req.userId },
      select: { googleCalendarRefreshToken: true },
    });
    finalRefreshToken = existing?.googleCalendarRefreshToken || null;
  }

  await prisma.user.update({
    where: { id: req.userId },
    data: {
      googleCalendarConnected: true,
      googleCalendarAccessToken: accessToken,
      googleCalendarRefreshToken: finalRefreshToken,
      googleCalendarTokenExpiresAt: expiresAt,
      googleCalendarEmail: email ?? null,
      googleCalendarName: name,
      googleCalendarAvatarUrl: picture,
      googleCalendarSyncedAt: new Date(),
    },
  });

  return res.json({
    success: true,
    data: {
      connected: true,
      email: email ?? null,
      name,
      avatarUrl: picture,
      syncedAt: new Date(),
    },
  });
}

// ============ Disconnect ============
export async function disconnect(req: Request, res: Response) {
  if (!req.userId) return sendError(res, 401, 'Tidak terautentikasi');

  await prisma.user.update({
    where: { id: req.userId },
    data: {
      googleCalendarConnected: false,
      googleCalendarAccessToken: null,
      googleCalendarRefreshToken: null,
      googleCalendarTokenExpiresAt: null,
      googleCalendarEmail: null,
      googleCalendarName: null,
      googleCalendarAvatarUrl: null,
      googleCalendarSyncedAt: null,
    },
  });

  return res.json({
    success: true,
    data: { connected: false },
  });
}

// ============ List Google Calendar Events ============
export async function listEvents(req: Request, res: Response) {
  if (!req.userId) return sendError(res, 401, 'Tidak terautentikasi');

  const tokenResult = await getValidUserToken(req.userId);
  if ('error' in tokenResult) {
    return sendError(res, tokenResult.code, tokenResult.error);
  }

  const { from, to } = req.query as { from?: string; to?: string };

  let timeMin: string;
  let timeMax: string;

  if (from) {
    timeMin = new Date(from).toISOString();
  } else {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    timeMin = start.toISOString();
  }

  if (to) {
    timeMax = new Date(to).toISOString();
  } else {
    const end = new Date(timeMin);
    end.setDate(end.getDate() + 35);
    timeMax = end.toISOString();
  }

  let items: GoogleCalendarEventItem[];
  try {
    items = await listGoogleEventItems(tokenResult.accessToken, timeMin, timeMax, 250);
  } catch (error) {
    if (error instanceof GoogleCalendarListError && error.status === 401) {
      // Coba refresh token dan retry sekali lagi
      const user = await prisma.user.findUnique({
        where: { id: req.userId },
        select: { googleCalendarRefreshToken: true },
      });
      if (user?.googleCalendarRefreshToken) {
        const refreshedToken = await refreshGoogleAccessToken(req.userId, user.googleCalendarRefreshToken);
        if (refreshedToken) {
          try {
            items = await listGoogleEventItems(refreshedToken, timeMin, timeMax, 250);
            const formatted = items
              .filter((item) => item.status !== 'cancelled' && Boolean(item.start?.dateTime || item.start?.date))
              .map((item) => ({
                id: item.id,
                title: item.summary || '(Tanpa judul)',
                description: item.description || null,
                location: item.location || null,
                htmlLink: item.htmlLink || null,
                start: item.start?.dateTime || item.start?.date,
                end: item.end?.dateTime || item.end?.date,
                allDay: !item.start?.dateTime,
                colorId: item.colorId || null,
                recurringEventId: item.recurringEventId || null,
              }));
            return res.json({ success: true, data: formatted });
          } catch (retryError) {
            console.error('[googleCalendar] retry listEvents gagal:', retryError);
          }
        }
      }

      await prisma.user.update({
        where: { id: req.userId },
        data: { googleCalendarConnected: false, googleCalendarAccessToken: null },
      });
      return sendError(res, 403, 'Sesi Google Calendar telah kedaluwarsa. Silakan hubungkan ulang.');
    }
    console.error('[googleCalendar] gagal mengambil event:', error);
    return sendError(res, 502, 'Gagal mengambil event dari Google Calendar.');
  }

  const formatted = items
    .filter((item) => item.status !== 'cancelled' && Boolean(item.start?.dateTime || item.start?.date))
    .map((item) => ({
      id: item.id,
      title: item.summary || '(Tanpa judul)',
      description: item.description || null,
      location: item.location || null,
      htmlLink: item.htmlLink || null,
      start: item.start?.dateTime || item.start?.date,
      end: item.end?.dateTime || item.end?.date,
      allDay: !item.start?.dateTime,
      colorId: item.colorId || null,
      recurringEventId: item.recurringEventId || null,
    }));

  return res.json({ success: true, data: formatted });
}

interface RecurrenceRuleConfig {
  freq: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';
  interval?: number;
  byDays?: number[];
  byMonthDay?: number;
  byWeekOfMonth?: {
    week: number;
    dayOfWeek: number;
  };
  endType?: 'NEVER' | 'ON_DATE' | 'AFTER';
  untilDate?: string | null;
  count?: number | null;
}

const RRULE_DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] as const;

function buildGoogleRecurrenceRule(raw: unknown): string[] | null {
  if (!raw || typeof raw !== 'object') return null;
  const rec = raw as RecurrenceRuleConfig;
  if (!rec.freq || !['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(rec.freq)) {
    return null;
  }

  const parts: string[] = [`FREQ=${rec.freq}`];
  const interval = Number(rec.interval) || 1;
  if (interval > 1) {
    parts.push(`INTERVAL=${interval}`);
  }

  if (rec.freq === 'WEEKLY' && Array.isArray(rec.byDays) && rec.byDays.length > 0) {
    const dayCodes = rec.byDays
      .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)
      .map((d) => RRULE_DAYS[d]);
    if (dayCodes.length > 0) {
      parts.push(`BYDAY=${dayCodes.join(',')}`);
    }
  } else if (rec.freq === 'MONTHLY') {
    if (
      rec.byWeekOfMonth &&
      typeof rec.byWeekOfMonth.week === 'number' &&
      typeof rec.byWeekOfMonth.dayOfWeek === 'number' &&
      rec.byWeekOfMonth.dayOfWeek >= 0 &&
      rec.byWeekOfMonth.dayOfWeek <= 6
    ) {
      parts.push(`BYDAY=${rec.byWeekOfMonth.week}${RRULE_DAYS[rec.byWeekOfMonth.dayOfWeek]}`);
    } else if (typeof rec.byMonthDay === 'number' && rec.byMonthDay >= 1 && rec.byMonthDay <= 31) {
      parts.push(`BYMONTHDAY=${rec.byMonthDay}`);
    }
  }

  if (rec.endType === 'AFTER' && typeof rec.count === 'number' && rec.count > 0) {
    parts.push(`COUNT=${Math.floor(rec.count)}`);
  } else if (rec.endType === 'ON_DATE' && typeof rec.untilDate === 'string' && rec.untilDate.trim()) {
    const cleaned = rec.untilDate.trim().replace(/-/g, '').slice(0, 8);
    if (/^\d{8}$/.test(cleaned)) {
      parts.push(`UNTIL=${cleaned}T235959Z`);
    }
  }

  return [`RRULE:${parts.join(';')}`];
}

// ============ Helper: Ekspor / Perbarui 1 Aktivitas ke Google Calendar ============
export async function pushActivityToGoogleCalendar(userId: string, activityId: string): Promise<string | null> {
  const tokenResult = await getValidUserToken(userId);
  if ('error' in tokenResult) return null;

  const activity = await prisma.dailyActivity.findFirst({
    where: { id: activityId, userId },
    include: { checklistItems: { orderBy: { order: 'asc' } } },
  });
  if (!activity) return null;

  const hasValidStartTime = activity.startTime && !isNaN(activity.startTime.getTime());
  const hasValidEndTime = activity.endTime && !isNaN(activity.endTime.getTime());
  const recurrenceRules = buildGoogleRecurrenceRule(activity.recurrence);
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Jakarta';

  let startIso: string | undefined;
  let endIso: string | undefined;
  let startStr: string | undefined;
  let endStr: string | undefined;

  let startPayload: { dateTime?: string | null; date?: string | null; timeZone?: string };
  let endPayload: { dateTime?: string | null; date?: string | null; timeZone?: string };

  if (hasValidStartTime) {
    startIso = activity.startTime!.toISOString();
    if (hasValidEndTime && activity.endTime!.getTime() > activity.startTime!.getTime()) {
      endIso = activity.endTime!.toISOString();
    } else {
      endIso = new Date(activity.startTime!.getTime() + 3600_000).toISOString();
    }
    // Set date: null agar PATCH Google API menghapus properti format all-day sebelumnya
    startPayload = { dateTime: startIso, date: null, timeZone };
    endPayload = { dateTime: endIso, date: null, timeZone };
  } else {
    // Untuk event sepanjang hari (all-day), Google Calendar API mewajibkan:
    // 1. Format tanggal YYYY-MM-DD
    // 2. end.date bersifat EKSKLUSIF (harus minimal 1 hari setelah start.date).
    const startDate = new Date(activity.date);
    const baseDate = isNaN(startDate.getTime()) ? new Date() : startDate;
    startStr = baseDate.toISOString().split('T')[0];

    const nextDate = new Date(baseDate);
    nextDate.setUTCDate(nextDate.getUTCDate() + 1);
    endStr = nextDate.toISOString().split('T')[0];

    // Set dateTime: null agar PATCH Google API menghapus properti jam sebelumnya
    startPayload = { date: startStr, dateTime: null };
    endPayload = { date: endStr, dateTime: null };
  }

  let description = activity.description || '';
  if (activity.checklistItems.length > 0) {
    description += '\n\nChecklist:\n' +
      activity.checklistItems.map((c) => `${c.completed ? '[x]' : '[ ]'} ${c.text}`).join('\n');
  }

  const eventPayload: Record<string, unknown> = {
    summary: activity.title,
    description: description.trim() || undefined,
    status: 'confirmed',
    start: startPayload,
    end: endPayload,
    ...(recurrenceRules
      ? { recurrence: recurrenceRules }
      : activity.googleEventId && activity.recurrence === null
        ? { recurrence: [] }
        : {}),
    ...(activity.color !== undefined ? { colorId: activity.color || null } : {}),
  };

  const cleanStartPayload = hasValidStartTime ? { dateTime: startIso, timeZone } : { date: startStr };
  const cleanEndPayload = hasValidStartTime ? { dateTime: endIso, timeZone } : { date: endStr };
  const postPayload: Record<string, unknown> = {
    summary: activity.title,
    description: description.trim() || undefined,
    status: 'confirmed',
    start: cleanStartPayload,
    end: cleanEndPayload,
    ...(recurrenceRules ? { recurrence: recurrenceRules } : {}),
    ...(activity.color ? { colorId: activity.color } : {}),
  };

  const targetGoogleEventId =
    recurrenceRules && activity.googleEventId?.includes('_')
      ? activity.googleEventId.split('_')[0]
      : activity.googleEventId;
  const isUpdate = Boolean(targetGoogleEventId);
  let gRes: globalThis.Response;

  try {
    if (isUpdate) {
      gRes = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(targetGoogleEventId!)}`,
        {
          method: 'PATCH',
          headers: {
            Authorization: `Bearer ${tokenResult.accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(eventPayload),
        },
      );

      // Jika event di Google Calendar sudah tidak ada (404/410) atau konflik format all-day vs timed (400), buat ulang via POST
      if (gRes.status === 404 || gRes.status === 410 || gRes.status === 400) {
        gRes = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${tokenResult.accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(postPayload),
        });
      }
    } else {
      gRes = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tokenResult.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(postPayload),
      });
    }

    if (!gRes.ok) {
      const errText = await gRes.text();
      console.error('[googleCalendar] pushActivityToGoogleCalendar gagal:', errText);
      return null;
    }

    const createdEvent = (await gRes.json()) as { id: string; status?: string };

    // Jika event yang di-patch ternyata masih berstatus cancelled di Google Calendar, buat event baru via POST
    if (createdEvent.status === 'cancelled') {
      const fallbackRes = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tokenResult.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(postPayload),
      });

      if (fallbackRes.ok) {
        const fallbackData = (await fallbackRes.json()) as { id: string; status?: string };
        createdEvent.id = fallbackData.id;
        createdEvent.status = fallbackData.status || 'confirmed';
      }
    }

    if (createdEvent.id && createdEvent.id !== activity.googleEventId) {
      await prisma.dailyActivity.update({
        where: { id: activity.id },
        data: { googleEventId: createdEvent.id },
      });
    }

    await prisma.user.update({
      where: { id: userId },
      data: { googleCalendarSyncedAt: new Date() },
    });

    emitToUser(userId, 'calendar:synced', {
      action: isUpdate ? 'update' : 'create',
      activityId: activity.id,
      googleEventId: createdEvent.id || activity.googleEventId,
    });

    return createdEvent.id || activity.googleEventId || null;
  } catch (err) {
    console.error('[googleCalendar] pushActivityToGoogleCalendar exception:', err);
    return null;
  }
}

// ============ Helper: Hapus Event di Google Calendar ============
export async function deleteEventFromGoogleCalendar(
  userId: string,
  googleEventId: string,
  occurrence?: { date: Date; startTime: Date | null },
): Promise<boolean> {
  const tokenResult = await getValidUserToken(userId);
  if ('error' in tokenResult) return false;

  try {
    let eventId = googleEventId;
    if (occurrence) {
      const lookup = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(googleEventId)}`,
        { headers: { Authorization: `Bearer ${tokenResult.accessToken}` } },
      );
      if (lookup.status === 404 || lookup.status === 410) return true;
      if (!lookup.ok) return false;
      const linkedEvent = (await lookup.json()) as GoogleCalendarEventItem;
      if (linkedEvent.status === 'cancelled') return true;
      if (linkedEvent.recurrence?.length) {
        const instance = await findRecurringInstanceForActivity(
          tokenResult.accessToken, googleEventId, occurrence.date, occurrence.startTime,
        );
        if (!instance) return false;
        if (instance.status === 'cancelled') return true;
        eventId = instance.id;
      }
    }
    const res = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${tokenResult.accessToken}` },
      },
    );
    return res.ok || res.status === 404;
  } catch (err) {
    console.error('[googleCalendar] deleteEventFromGoogleCalendar error:', err);
    return false;
  }
}

// ============ Helper: Sinkronisasi 2 Arah Otomatis ============
export async function autoSyncTwoWay(
  userId: string,
  startDateStr?: string,
  endDateStr?: string,
): Promise<{ pushedCount: number; importedCount: number }> {
  return withUserCalendarLock(userId, () => autoSyncTwoWayUnlocked(userId, startDateStr, endDateStr));
}

async function autoSyncTwoWayUnlocked(
  userId: string,
  startDateStr?: string,
  endDateStr?: string,
): Promise<{ pushedCount: number; importedCount: number }> {
  const tokenResult = await getValidUserToken(userId);
  if ('error' in tokenResult) {
    return { pushedCount: 0, importedCount: 0 };
  }

  const now = new Date();
  const defaultStart = new Date(now);
  defaultStart.setHours(0, 0, 0, 0);
  const defaultEnd = new Date(now);
  defaultEnd.setHours(23, 59, 59, 999);

  const startDate = startDateStr ? new Date(startDateStr) : defaultStart;
  const endDate = endDateStr ? new Date(endDateStr) : defaultEnd;


  // 1. Ekspor aktivitas lokal dalam rentang waktu yang belum punya googleEventId
  const unsyncedActivities = await prisma.dailyActivity.findMany({
    where: {
      userId,
      googleEventId: null,
      date: {
        gte: startDate,
        lte: endDate,
      },
    },
    take: 50,
  });

  let pushedCount = 0;
  for (const act of unsyncedActivities) {
    try {
      const gId = await pushActivityToGoogleCalendar(userId, act.id);
      if (gId) pushedCount++;
    } catch {
      // abaikan kegagalan individual
    }
  }

  // 2. Tarik event dari Google Calendar API
  let importedCount = 0;
  try {
    const items = await listGoogleEventItems(
      tokenResult.accessToken,
      startDate.toISOString(),
      endDate.toISOString(),
      150,
    );
    const activeEventIds = new Set(items.filter((item) => item.status !== 'cancelled').map((item) => item.id));

      for (const item of items) {
        if (!item.id) continue;

        if (item.status === 'cancelled') {
          // Jika event berstatus cancelled di Google, dan masih ada di DailyActivity lokal, bersihkan juga di lokal
          await prisma.dailyActivity.deleteMany({
            where: { userId, googleEventId: item.id },
          });
          continue;
        }

        if (!item.start) continue;

        const isAllDay = !item.start.dateTime;
        const startIso = item.start.dateTime || item.start.date;
        if (!startIso) continue;

        const startDateObj = new Date(startIso);
        if (isNaN(startDateObj.getTime())) continue;

        const dateOnly = new Date(startDateObj);
        dateOnly.setHours(0, 0, 0, 0);

        const startTime = isAllDay ? null : startDateObj;
        const endTime = item.end?.dateTime ? new Date(item.end.dateTime) : null;

        let existing = await prisma.dailyActivity.findFirst({
          where: { userId, googleEventId: item.id },
        });

        const baseId = item.recurringEventId || (item.id.includes('_') ? item.id.split('_')[0] : null);
        if (baseId) {
          activeEventIds.add(baseId);
          // Jika aktivitas lokal merupakan master kegiatan berulang (memiliki aturan recurrence),
          // jangan buat baris duplikat baru untuk setiap instansi tanggalnya.
          const recurringMaster = await prisma.dailyActivity.findFirst({
            where: {
              userId,
              OR: [{ googleEventId: baseId }, { googleEventId: item.id }],
              NOT: { recurrence: { equals: Prisma.DbNull } },
            },
          });
          if (recurringMaster) {
            if (recurringMaster.googleEventId !== baseId) {
              await prisma.dailyActivity.update({
                where: { id: recurringMaster.id },
                data: { googleEventId: baseId },
              });
            }
            continue;
          }
        }

        // Cek juga base ID jika item.id memiliki suffix recurrence (_...) tapi HANYA pada tanggal yang sama
        if (!existing && item.id.includes('_')) {
          const splitBaseId = item.id.split('_')[0];
          existing = await prisma.dailyActivity.findFirst({
            where: {
              userId,
              googleEventId: splitBaseId,
              date: dateOnly,
            },
          });
        }

        // Jika belum ada berdasarkan googleEventId, cari aktivitas lokal dengan judul dan rentang waktu yang sama
        if (!existing) {
          const summaryTitle = (item.summary || '').trim();
          const cleanTitle = summaryTitle.replace(/[()]/g, '').trim().toLowerCase();

          // Cari aktivitas lokal di sekitar jam/tanggal ini
          const dayCandidates = await prisma.dailyActivity.findMany({
            where: {
              userId,
              ...(startTime
                ? {
                    startTime: {
                      gte: new Date(startTime.getTime() - 20 * 60000),
                      lte: new Date(startTime.getTime() + 20 * 60000),
                    },
                  }
                : {
                    date: {
                      gte: new Date(dateOnly.getTime() - 86400000),
                      lte: new Date(dateOnly.getTime() + 86400000),
                    },
                  }),
            },
          });

          const matchedLocal = dayCandidates.find((cand) => {
            const candTitle = (cand.title || '').trim().replace(/[()]/g, '').trim().toLowerCase();
            if (candTitle === 'tanpa judul' && cleanTitle === 'tanpa judul') {
              return true;
            }
            if (candTitle && cleanTitle && candTitle === cleanTitle) {
              return true;
            }
            return false;
          });

          if (matchedLocal) {
            existing = matchedLocal;
            if (!matchedLocal.googleEventId || matchedLocal.googleEventId !== item.id) {
              await prisma.dailyActivity.update({
                where: { id: matchedLocal.id },
                data: { googleEventId: item.id },
              });
            }
          }
        }

        if (existing) {
          // Jika event Google tidak punya dateTime (isAllDay) tapi di lokal sudah punya waktu, jangan hapus jam lokal
          const finalStartTime = !isAllDay ? startDateObj : (existing.startTime ?? null);
          const finalEndTime = item.end?.dateTime
            ? new Date(item.end.dateTime)
            : (!isAllDay ? null : (existing.endTime ?? null));

          // Perbarui data jika ada perubahan di Google Calendar, pastikan googleEventId spesifik tersimpan
          await prisma.dailyActivity.update({
            where: { id: existing.id },
            data: {
              title: item.summary || existing.title,
              description: item.description !== undefined ? item.description : existing.description,
              date: dateOnly,
              startTime: finalStartTime,
              endTime: finalEndTime,
              googleEventId: item.id,
              color: item.colorId || null,
            },
          });
        } else {
          // Opsi A: Otomatis buat kegiatan di Purrific agar muncul di kalender & tabel
          await prisma.dailyActivity.create({
            data: {
              userId,
              title: item.summary || '(Tanpa judul)',
              description: item.description || null,
              date: dateOnly,
              startTime,
              endTime,
              type: 'CUSTOM',
              status: 'PENDING',
              googleEventId: item.id,
              color: item.colorId || null,
            },
          });
          importedCount++;
        }
      }

    // Event yang dihapus langsung di Google biasanya hilang dari daftar biasa.
    // Periksa ID lokal yang tidak terlihat sebelum menghapusnya: event bisa saja
    // hanya dipindah ke tanggal di luar rentang yang sedang disinkronkan.
    const linkedActivities = await prisma.dailyActivity.findMany({
      where: {
        userId,
        googleEventId: { not: null },
        date: { gte: startDate, lte: endDate },
      },
    });
    for (const activity of linkedActivities) {
      if (activity.recurrence) continue; // Lindungi master kegiatan berulang agar tidak tertimpa/dihapus oleh pengecekan instansi tunggal
      const eventId = activity.googleEventId;
      if (!eventId || activeEventIds.has(eventId)) continue;
      try {
        const response = await fetch(
          `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}`,
          { headers: { Authorization: `Bearer ${tokenResult.accessToken}` } },
        );
        if (response.status === 404 || response.status === 410) {
          await prisma.dailyActivity.deleteMany({
            where: { id: activity.id, userId, googleEventId: eventId },
          });
          continue;
        }
        if (!response.ok) {
          console.error('[googleCalendar] gagal memeriksa event yang hilang:', response.status, eventId);
          continue;
        }
        const event = (await response.json()) as GoogleCalendarEventItem;
        const occurrence = event.recurrence?.length
          ? await findRecurringInstanceForActivity(tokenResult.accessToken, eventId, activity.date, activity.startTime)
          : event;
        if (!occurrence) continue;
        if (occurrence.status === 'cancelled') {
          await prisma.dailyActivity.deleteMany({
            where: { id: activity.id, userId, googleEventId: eventId },
          });
          continue;
        }
        const movedStart = occurrence.start?.dateTime || occurrence.start?.date;
        if (!movedStart) continue;
        const movedDate = new Date(movedStart);
        if (isNaN(movedDate.getTime())) continue;
        movedDate.setHours(0, 0, 0, 0);
        await prisma.dailyActivity.updateMany({
          where: { id: activity.id, userId, googleEventId: eventId },
          data: {
            title: occurrence.summary || activity.title,
            description: occurrence.description !== undefined ? occurrence.description : activity.description,
            date: movedDate,
            startTime: occurrence.start?.dateTime ? new Date(occurrence.start.dateTime) : null,
            endTime: occurrence.end?.dateTime ? new Date(occurrence.end.dateTime) : null,
            googleEventId: occurrence.id,
          },
        });
      } catch (error) {
        console.error('[googleCalendar] gagal memeriksa event yang hilang:', error);
      }
    }
  } catch (err) {
    console.error('[googleCalendar] autoSyncTwoWay fetch error:', err);
    throw err;
  }

  await prisma.user.update({
    where: { id: userId },
    data: { googleCalendarSyncedAt: new Date() },
  });

  try {
    emitToUser(userId, 'calendar:synced', { action: 'autoSync', pushedCount, importedCount });
  } catch {
    // socket error diabaikan jika belum connect
  }

  return { pushedCount, importedCount };
}

// ============ Endpoint: Sync Single Activity ============
export async function syncActivity(req: Request, res: Response) {
  if (!req.userId) return sendError(res, 401, 'Tidak terautentikasi');

  const gId = await pushActivityToGoogleCalendar(req.userId, req.params.activityId);
  if (!gId) {
    return sendError(res, 500, 'Gagal menyinkronkan aktivitas ke Google Calendar.');
  }

  const updatedActivity = await prisma.dailyActivity.findUnique({
    where: { id: req.params.activityId },
    include: { checklistItems: true },
  });

  return res.json({
    success: true,
    data: {
      activity: updatedActivity,
      googleEventId: gId,
    },
  });
}

// ============ Endpoint: Auto Sync 2 Arah ============
export async function handleAutoSync(req: Request, res: Response) {
  if (!req.userId) return sendError(res, 401, 'Tidak terautentikasi');
  const { startDate, endDate } = (req.body || {}) as { startDate?: string; endDate?: string };

  const result = await autoSyncTwoWay(req.userId, startDate, endDate);
  return res.json({
    success: true,
    data: result,
  });
}

// ============ Import Google Events to Purrific Daily Activities ============
const importSchema = z.object({
  events: z.array(
    z.object({
      id: z.string(),
      title: z.string().min(1),
      description: z.string().nullable().optional(),
      start: z.string(),
      end: z.string().optional(),
    }),
  ),
});

export async function importEvents(req: Request, res: Response) {
  if (!req.userId) return sendError(res, 401, 'Tidak terautentikasi');
  const body = importSchema.parse(req.body);

  let importedCount = 0;

  for (const item of body.events) {
    // Hindari duplikasi jika sudah ada dengan googleEventId yang sama
    let existing = await prisma.dailyActivity.findFirst({
      where: { userId: req.userId, googleEventId: item.id },
    });

    if (!existing && item.id.includes('_')) {
      const baseId = item.id.split('_')[0];
      existing = await prisma.dailyActivity.findFirst({
        where: { userId: req.userId, googleEventId: baseId },
      });
    }

    if (existing) continue;

    const startDate = new Date(item.start);
    if (isNaN(startDate.getTime())) continue;

    const dateOnly = new Date(startDate);
    dateOnly.setHours(0, 0, 0, 0);

    const hasTime = item.start.includes('T');
    const startTime = hasTime ? startDate : null;
    const endTime = item.end && item.end.includes('T') ? new Date(item.end) : null;

    // Hindari duplikasi dengan kegiatan lokal yang memiliki judul dan rentang waktu yang sama
    const summaryTitle = (item.title || '').trim();
    const cleanTitle = summaryTitle.replace(/[()]/g, '').trim().toLowerCase();

    const candidates = await prisma.dailyActivity.findMany({
      where: {
        userId: req.userId,
        ...(startTime
          ? {
              startTime: {
                gte: new Date(startTime.getTime() - 20 * 60000),
                lte: new Date(startTime.getTime() + 20 * 60000),
              },
            }
          : {
              date: {
                gte: new Date(dateOnly.getTime() - 86400000),
                lte: new Date(dateOnly.getTime() + 86400000),
              },
            }),
      },
    });

    const duplicateMatch = candidates.find((cand) => {
      const candTitle = (cand.title || '').trim().replace(/[()]/g, '').trim().toLowerCase();
      if (candTitle === 'tanpa judul' && cleanTitle === 'tanpa judul') {
        return true;
      }
      if (candTitle && cleanTitle && candTitle === cleanTitle) {
        return true;
      }
      return false;
    });

    if (duplicateMatch) {
      if (!duplicateMatch.googleEventId) {
        await prisma.dailyActivity.update({
          where: { id: duplicateMatch.id },
          data: { googleEventId: item.id },
        });
      }
      continue;
    }

    await prisma.dailyActivity.create({
      data: {
        userId: req.userId,
        title: item.title,
        description: item.description || null,
        date: dateOnly,
        startTime,
        endTime,
        type: 'CUSTOM',
        status: 'PENDING',
        googleEventId: item.id,
      },
    });

    importedCount += 1;
  }

  await prisma.user.update({
    where: { id: req.userId },
    data: { googleCalendarSyncedAt: new Date() },
  });

  return res.json({
    success: true,
    data: { importedCount },
  });
}

// ============ Update Google Calendar Event ============
const updateEventSchema = z.object({
  title: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  date: z.string().optional(),
  startTime: z.string().nullable().optional(),
  endTime: z.string().nullable().optional(),
  recurrence: z.record(z.unknown()).nullable().optional(),
  colorId: z.string().nullable().optional(),
});

export async function updateEvent(req: Request, res: Response) {
  if (!req.userId) return sendError(res, 401, 'Tidak terautentikasi');
  const tokenResult = await getValidUserToken(req.userId);
  if ('error' in tokenResult) {
    return sendError(res, tokenResult.code, tokenResult.error);
  }

  const eventId = req.params.eventId;
  const body = updateEventSchema.parse(req.body);

  const hasStartTime = Boolean(body.startTime && !isNaN(new Date(body.startTime).getTime()));
  const hasEndTime = Boolean(body.endTime && !isNaN(new Date(body.endTime).getTime()));
  const recurrenceRules = body.recurrence !== undefined ? buildGoogleRecurrenceRule(body.recurrence) : undefined;
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Jakarta';

  let startPayload: { dateTime?: string | null; date?: string | null; timeZone?: string } = {};
  let endPayload: { dateTime?: string | null; date?: string | null; timeZone?: string } = {};

  let startIso: string | undefined;
  let endIso: string | undefined;
  let startStr: string | undefined;
  let endStr: string | undefined;

  if (hasStartTime) {
    startIso = new Date(body.startTime!).toISOString();
    if (hasEndTime && new Date(body.endTime!).getTime() > new Date(body.startTime!).getTime()) {
      endIso = new Date(body.endTime!).toISOString();
    } else {
      endIso = new Date(new Date(body.startTime!).getTime() + 3600_000).toISOString();
    }
    startPayload = { dateTime: startIso, date: null, timeZone };
    endPayload = { dateTime: endIso, date: null, timeZone };
  } else if (body.date) {
    const baseDate = new Date(body.date);
    const validDate = isNaN(baseDate.getTime()) ? new Date() : baseDate;
    startStr = validDate.toISOString().split('T')[0];

    const nextDate = new Date(validDate);
    nextDate.setUTCDate(nextDate.getUTCDate() + 1);
    endStr = nextDate.toISOString().split('T')[0];

    startPayload = { date: startStr, dateTime: null };
    endPayload = { date: endStr, dateTime: null };
  }

  const eventPayload: Record<string, unknown> = {};
  if (body.title) eventPayload.summary = body.title;
  if (body.description !== undefined) eventPayload.description = body.description;
  if (startPayload.dateTime !== undefined || startPayload.date !== undefined) eventPayload.start = startPayload;
  if (endPayload.dateTime !== undefined || endPayload.date !== undefined) eventPayload.end = endPayload;
  if (body.recurrence !== undefined) {
    eventPayload.recurrence = recurrenceRules ?? [];
  }
  if (body.colorId !== undefined) {
    eventPayload.colorId = body.colorId || null;
  }

  const targetEventId =
    recurrenceRules && eventId.includes('_') ? eventId.split('_')[0] : eventId;

  try {
    let gRes = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(targetEventId)}`,
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${tokenResult.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(eventPayload),
      },
    );

    if (gRes.status === 400 || gRes.status === 404 || gRes.status === 410) {
      const cleanStart = hasStartTime ? { dateTime: startIso, timeZone } : { date: startStr };
      const cleanEnd = hasStartTime ? { dateTime: endIso, timeZone } : { date: endStr };
      const postPayload: Record<string, unknown> = {
        summary: body.title || 'Tanpa judul',
        description: body.description || undefined,
        start: cleanStart,
        end: cleanEnd,
        ...(recurrenceRules ? { recurrence: recurrenceRules } : {}),
        ...(body.colorId ? { colorId: body.colorId } : {}),
      };
      gRes = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tokenResult.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(postPayload),
      });
    }

    if (!gRes.ok) {
      const errText = await gRes.text();
      console.error('[googleCalendar] updateEvent gagal:', errText);
      return sendError(res, 502, 'Gagal memperbarui event di Google Calendar.');
    }

    const updatedGoogleData = (await gRes.json()) as { id?: string };
    const finalEventId = updatedGoogleData.id || targetEventId;

    // Periksa apakah ada DailyActivity lokal yang tertaut
    const existing = await prisma.dailyActivity.findFirst({
      where: {
        userId: req.userId,
        OR: [{ googleEventId: eventId }, { googleEventId: targetEventId }, { googleEventId: finalEventId }],
      },
    });

    const actDate = body.date
      ? new Date(body.date)
      : hasStartTime
        ? new Date(body.startTime!)
        : new Date();
    actDate.setHours(0, 0, 0, 0);

    const recurrenceDbVal =
      body.recurrence === undefined
        ? undefined
        : body.recurrence === null
          ? Prisma.DbNull
          : (body.recurrence as unknown as Prisma.InputJsonValue);

    if (existing) {
      await prisma.dailyActivity.update({
        where: { id: existing.id },
        data: {
          title: body.title || existing.title,
          description: body.description !== undefined ? body.description : existing.description,
          date: actDate,
          startTime: hasStartTime ? new Date(body.startTime!) : null,
          endTime: hasEndTime ? new Date(body.endTime!) : null,
          googleEventId: finalEventId,
          ...(recurrenceDbVal !== undefined ? { recurrence: recurrenceDbVal } : {}),
          ...(body.colorId !== undefined ? { color: body.colorId || null } : {}),
        },
      });
    } else {
      await prisma.dailyActivity.create({
        data: {
          userId: req.userId,
          title: body.title || '(Tanpa judul)',
          description: body.description || null,
          date: actDate,
          startTime: hasStartTime ? new Date(body.startTime!) : null,
          endTime: hasEndTime ? new Date(body.endTime!) : null,
          type: 'CUSTOM',
          status: 'PENDING',
          googleEventId: finalEventId,
          ...(recurrenceDbVal !== undefined ? { recurrence: recurrenceDbVal } : {}),
          color: body.colorId || null,
        },
      });
    }

    emitToUser(req.userId, 'calendar:synced', { action: 'update', eventId: finalEventId });

    return res.json({ success: true, data: { id: finalEventId } });
  } catch (err) {
    console.error('[googleCalendar] updateEvent exception:', err);
    return sendError(res, 500, 'Terjadi kesalahan saat memperbarui event Google.');
  }
}

// ============ Delete Google Calendar Event ============
export async function deleteEvent(req: Request, res: Response) {
  if (!req.userId) return sendError(res, 401, 'Tidak terautentikasi');
  const userId = req.userId;
  const eventId = req.params.eventId;

  return withUserCalendarLock(userId, async () => {
    const success = await deleteEventFromGoogleCalendar(userId, eventId);
    if (!success) {
      return sendError(res, 502, 'Gagal menghapus event dari Google Calendar.');
    }

    await prisma.dailyActivity.deleteMany({
      where: { userId, googleEventId: eventId },
    });
    emitToUser(userId, 'calendar:synced', { action: 'delete', eventId });

    return res.json({ success: true, data: { id: eventId } });
  });
}

// ============ Create Google Calendar Event ============
const createEventSchema = z.object({
  title: z.string().min(1),
  description: z.string().nullable().optional(),
  date: z.string().optional(),
  startTime: z.string().nullable().optional(),
  endTime: z.string().nullable().optional(),
});

export async function createEvent(req: Request, res: Response) {
  if (!req.userId) return sendError(res, 401, 'Tidak terautentikasi');
  const tokenResult = await getValidUserToken(req.userId);
  if ('error' in tokenResult) {
    return sendError(res, tokenResult.code, tokenResult.error);
  }

  const body = createEventSchema.parse(req.body);
  const hasStartTime = Boolean(body.startTime && !isNaN(new Date(body.startTime).getTime()));
  const hasEndTime = Boolean(body.endTime && !isNaN(new Date(body.endTime).getTime()));

  let startIso: string | undefined;
  let endIso: string | undefined;
  let startStr: string | undefined;
  let endStr: string | undefined;

  if (hasStartTime) {
    startIso = new Date(body.startTime!).toISOString();
    if (hasEndTime && new Date(body.endTime!).getTime() > new Date(body.startTime!).getTime()) {
      endIso = new Date(body.endTime!).toISOString();
    } else {
      endIso = new Date(new Date(body.startTime!).getTime() + 3600_000).toISOString();
    }
  } else if (body.date) {
    const baseDate = new Date(body.date);
    const validDate = isNaN(baseDate.getTime()) ? new Date() : baseDate;
    startStr = validDate.toISOString().split('T')[0];

    const nextDate = new Date(validDate);
    nextDate.setUTCDate(nextDate.getUTCDate() + 1);
    endStr = nextDate.toISOString().split('T')[0];
  } else {
    return sendError(res, 400, 'Waktu mulai atau tanggal wajib diisi.');
  }

  const postPayload = {
    summary: body.title,
    description: body.description || undefined,
    start: hasStartTime ? { dateTime: startIso } : { date: startStr },
    end: hasStartTime ? { dateTime: endIso } : { date: endStr },
  };

  try {
    const gRes = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokenResult.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(postPayload),
    });

    if (!gRes.ok) {
      const errText = await gRes.text();
      console.error('[googleCalendar] createEvent error:', errText);
      return sendError(res, 502, 'Gagal membuat event di Google Calendar.');
    }

    const created = (await gRes.json()) as { id: string };
    emitToUser(req.userId, 'calendar:synced', { action: 'create', eventId: created.id });

    return res.status(201).json({ success: true, data: { id: created.id } });
  } catch (err) {
    console.error('[googleCalendar] createEvent exception:', err);
    return sendError(res, 500, 'Terjadi kesalahan saat membuat event Google.');
  }
}

