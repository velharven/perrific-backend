import { prisma } from './prisma';
import { assertConnection, currentConnectionId } from './calendarConnection';

export interface GoogleCalendarEventItem {
  id: string;
  etag?: string;
  updated?: string;
  extendedProperties?: { private?: Record<string, string> };
  summary?: string;
  description?: string;
  location?: string;
  htmlLink?: string;
  status?: string;
  recurrence?: string[];
  recurringEventId?: string;
  originalStartTime?: { dateTime?: string; date?: string; timeZone?: string };
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string; timeZone?: string };
  colorId?: string;
}

export class GoogleCalendarListError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function listGoogleEventItems(
  accessToken: string,
  timeMin: string,
  timeMax: string,
  maxResults: number,
) {
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
      signal: AbortSignal.timeout(15000),
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

export async function findRecurringInstanceForActivity(
  accessToken: string,
  parentId: string,
  date: Date,
  startTime: Date | null,
): Promise<GoogleCalendarEventItem | null> {
  const reference = startTime ?? date;
  const url = new URL(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(parentId)}/instances`,
  );
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
    const page = (await response.json()) as {
      items?: GoogleCalendarEventItem[];
      nextPageToken?: string;
    };
    instances.push(...(page.items ?? []));
    pageToken = page.nextPageToken;
  } while (pageToken);

  const maxDifference = startTime ? 60000 : 12 * 3600000;
  return (
    instances
      .map((item) => ({
        item,
        difference: Math.abs(
          new Date(
            item.start?.dateTime ||
              item.start?.date ||
              item.originalStartTime?.dateTime ||
              item.originalStartTime?.date ||
              '',
          ).getTime() - reference.getTime(),
        ),
      }))
      .filter(({ difference }) => Number.isFinite(difference) && difference <= maxDifference)
      .sort((a, b) => a.difference - b.difference)[0]?.item ?? null
  );
}

const tokenRefreshes = new Map<string, Promise<string | null>>();

export async function refreshGoogleAccessToken(
  userId: string,
  refreshToken: string,
): Promise<string | null> {
  const key = `${userId}:${refreshToken}`;
  const current = tokenRefreshes.get(key);
  if (current) return current;
  const refresh = refreshAccessToken(userId, refreshToken);
  tokenRefreshes.set(key, refresh);
  try {
    return await refresh;
  } finally {
    if (tokenRefreshes.get(key) === refresh) tokenRefreshes.delete(key);
  }
}

async function refreshAccessToken(userId: string, refreshToken: string): Promise<string | null> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    console.error(
      '[googleCalendar] GOOGLE_CLIENT_ID atau GOOGLE_CLIENT_SECRET tidak dikonfigurasi.',
    );
    return null;
  }

  try {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      signal: AbortSignal.timeout(15000),
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
        await prisma.user.updateMany({
          where: {
            id: userId,
            googleCalendarConnected: true,
            googleCalendarRefreshToken: refreshToken,
          },
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

    const saved = await prisma.user.updateMany({
      where: {
        id: userId,
        googleCalendarConnected: true,
        googleCalendarRefreshToken: refreshToken,
      },
      data: {
        googleCalendarAccessToken: data.access_token,
        googleCalendarTokenExpiresAt: expiresAt,
      },
    });
    if (!saved.count) return null;
    return data.access_token;
  } catch (error) {
    console.error('[googleCalendar] Exception saat refreshGoogleAccessToken:', error);
    return null;
  }
}

export async function getValidUserToken(
  userId: string,
  expected?: string | null,
): Promise<{ accessToken: string; connectionId: string } | { error: string; code: number }> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      googleCalendarConnected: true,
      googleCalendarConnectionId: true,
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
      const connectionId = await assertConnection(
        userId,
        expected ?? user.googleCalendarConnectionId ?? undefined,
      );
      if (!connectionId) return { error: 'Google Calendar belum terhubung.', code: 400 };
      return { accessToken: refreshedToken, connectionId };
    }
    const current = await prisma.user.findUnique({
      where: { id: userId },
      select: { googleCalendarConnected: true },
    });
    if (!current?.googleCalendarConnected)
      return { error: 'Google Calendar belum terhubung.', code: 400 };
  }

  if (!user.googleCalendarAccessToken) {
    return { error: 'Sesi Google Calendar telah kedaluwarsa. Silakan hubungkan ulang.', code: 403 };
  }

  const connectionId = await currentConnectionId(userId);
  const latest = await prisma.user.findUnique({
    where: { id: userId },
    select: { googleCalendarAccessToken: true, googleCalendarConnectionId: true },
  });
  if (
    latest?.googleCalendarAccessToken !== user.googleCalendarAccessToken ||
    latest.googleCalendarConnectionId !== connectionId
  )
    return { error: 'Akun Google telah berubah. Muat ulang kalender.', code: 409 };
  await assertConnection(
    userId,
    expected === undefined ? (user.googleCalendarConnectionId ?? connectionId) : expected,
  );
  if (!connectionId) return { error: 'Google Calendar belum terhubung.', code: 400 };
  return { accessToken: user.googleCalendarAccessToken, connectionId };
}

interface RecurrenceRuleConfig {
  freq: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';
  interval?: number;
  byDays?: number[];
  weekStartsOn?: number;
  byMonthDay?: number;
  byWeekOfMonth?: {
    week: number;
    dayOfWeek: number;
  };
  endType?: 'NEVER' | 'ON_DATE' | 'AFTER';
  untilDate?: string | null;
  count?: number | null;
  excludeDates?: string[];
}

const RRULE_DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] as const;

export function buildGoogleRecurrenceRule(raw: unknown): string[] | null {
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
  } else if (
    rec.endType === 'ON_DATE' &&
    typeof rec.untilDate === 'string' &&
    rec.untilDate.trim()
  ) {
    const cleaned = rec.untilDate.trim().replace(/-/g, '').slice(0, 8);
    if (/^\d{8}$/.test(cleaned)) {
      parts.push(`UNTIL=${cleaned}T235959Z`);
    }
  }

  const rules: string[] = [`RRULE:${parts.join(';')}`];
  if (Number.isInteger(rec.weekStartsOn) && rec.weekStartsOn! >= 0 && rec.weekStartsOn! <= 6)
    rules[0] += `;WKST=${RRULE_DAYS[rec.weekStartsOn!]}`;
  if (Array.isArray(rec.excludeDates) && rec.excludeDates.length > 0) {
    const validExdates = rec.excludeDates
      .map((d) => d.trim().replace(/-/g, '').slice(0, 8))
      .filter((d) => /^\d{8}$/.test(d));
    if (validExdates.length > 0) {
      rules.push(`EXDATE;VALUE=DATE:${validExdates.join(',')}`);
    }
  }

  return rules;
}
