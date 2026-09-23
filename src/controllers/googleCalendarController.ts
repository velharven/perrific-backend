import type { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { sendError } from '../lib/errors';
import { emitToUser } from '../lib/socket';

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
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
}

async function getValidUserToken(userId: string): Promise<{ accessToken: string } | { error: string; code: number }> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { googleCalendarConnected: true, googleCalendarAccessToken: true },
  });

  if (!user || !user.googleCalendarConnected || !user.googleCalendarAccessToken) {
    return { error: 'Google Calendar belum terhubung.', code: 400 };
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
  accessToken: z.string().min(1),
  email: z.string().email().optional(),
});

export async function connect(req: Request, res: Response) {
  if (!req.userId) return sendError(res, 401, 'Tidak terautentikasi');
  const body = connectSchema.parse(req.body);

  // Verifikasi access token ke Google tokeninfo
  const tokenInfoRes = await fetch(
    `https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(body.accessToken)}`,
  );

  if (!tokenInfoRes.ok) {
    return sendError(res, 400, 'Access token Google tidak valid atau sudah kedaluwarsa.');
  }

  const tokenInfo = (await tokenInfoRes.json()) as GoogleTokenInfo;

  let email = body.email || tokenInfo.email;
  let name: string | null = null;
  let picture: string | null = null;

  // Ambil profil lengkap dari Google userinfo
  const userRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: `Bearer ${body.accessToken}` },
  });
  if (userRes.ok) {
    const userInfo = (await userRes.json()) as GoogleUserInfo;
    email = userInfo.email || email;
    name = userInfo.name || null;
    picture = userInfo.picture || null;
  }

  await prisma.user.update({
    where: { id: req.userId },
    data: {
      googleCalendarConnected: true,
      googleCalendarAccessToken: body.accessToken,
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

  const url = new URL('https://www.googleapis.com/calendar/v3/calendars/primary/events');
  url.searchParams.set('timeMin', timeMin);
  url.searchParams.set('timeMax', timeMax);
  url.searchParams.set('singleEvents', 'true');
  url.searchParams.set('orderBy', 'startTime');
  url.searchParams.set('maxResults', '250');

  const gRes = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${tokenResult.accessToken}` },
  });

  if (gRes.status === 401) {
    await prisma.user.update({
      where: { id: req.userId },
      data: { googleCalendarConnected: false, googleCalendarAccessToken: null },
    });
    return sendError(res, 401, 'Sesi Google Calendar telah kedaluwarsa. Silakan hubungkan ulang.');
  }

  if (!gRes.ok) {
    const errText = await gRes.text();
    console.error('[googleCalendar] gagal mengambil event:', errText);
    return sendError(res, 502, 'Gagal mengambil event dari Google Calendar.');
  }

  const gData = (await gRes.json()) as { items?: GoogleCalendarEventItem[] };
  const items = gData.items ?? [];

  const formatted = items.map((item) => ({
    id: item.id,
    title: item.summary || '(Tanpa judul)',
    description: item.description || null,
    location: item.location || null,
    htmlLink: item.htmlLink || null,
    start: item.start?.dateTime || item.start?.date,
    end: item.end?.dateTime || item.end?.date,
    allDay: !item.start?.dateTime,
  }));

  return res.json({ success: true, data: formatted });
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

  const dateStr = activity.date.toISOString().split('T')[0];

  let startPayload: { dateTime?: string; date?: string };
  let endPayload: { dateTime?: string; date?: string };

  if (activity.startTime) {
    startPayload = { dateTime: activity.startTime.toISOString() };
    endPayload = activity.endTime
      ? { dateTime: activity.endTime.toISOString() }
      : { dateTime: new Date(activity.startTime.getTime() + 3600_000).toISOString() };
  } else {
    startPayload = { date: dateStr };
    endPayload = { date: dateStr };
  }

  let description = activity.description || '';
  if (activity.checklistItems.length > 0) {
    description += '\n\nChecklist:\n' +
      activity.checklistItems.map((c) => `${c.completed ? '☑' : '☐'} ${c.text}`).join('\n');
  }

  const eventPayload = {
    summary: activity.title,
    description: description.trim() || undefined,
    start: startPayload,
    end: endPayload,
  };

  const isUpdate = Boolean(activity.googleEventId);
  let gRes: globalThis.Response;

  try {
    if (isUpdate) {
      gRes = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(activity.googleEventId!)}`,
        {
          method: 'PATCH',
          headers: {
            Authorization: `Bearer ${tokenResult.accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(eventPayload),
        },
      );
    } else {
      gRes = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tokenResult.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(eventPayload),
      });
    }

    if (!gRes.ok) {
      const errText = await gRes.text();
      console.error('[googleCalendar] pushActivityToGoogleCalendar gagal:', errText);
      return null;
    }

    const createdEvent = (await gRes.json()) as { id: string };

    if (!isUpdate && createdEvent.id) {
      await prisma.dailyActivity.update({
        where: { id: activity.id },
        data: { googleEventId: createdEvent.id },
      });
    }

    await prisma.user.update({
      where: { id: userId },
      data: { googleCalendarSyncedAt: new Date() },
    });

    return createdEvent.id || activity.googleEventId || null;
  } catch (err) {
    console.error('[googleCalendar] pushActivityToGoogleCalendar exception:', err);
    return null;
  }
}

// ============ Helper: Hapus Event di Google Calendar ============
export async function deleteEventFromGoogleCalendar(userId: string, googleEventId: string): Promise<boolean> {
  const tokenResult = await getValidUserToken(userId);
  if ('error' in tokenResult) return false;

  try {
    const res = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(googleEventId)}`,
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
    const url = new URL('https://www.googleapis.com/calendar/v3/calendars/primary/events');
    url.searchParams.set('timeMin', startDate.toISOString());
    url.searchParams.set('timeMax', endDate.toISOString());
    url.searchParams.set('singleEvents', 'true');
    url.searchParams.set('orderBy', 'startTime');
    url.searchParams.set('maxResults', '150');

    const gRes = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${tokenResult.accessToken}` },
    });

    if (gRes.ok) {
      const gData = (await gRes.json()) as { items?: GoogleCalendarEventItem[] };
      const items = gData.items ?? [];

      for (const item of items) {
        if (!item.id || !item.start) continue;

        const isAllDay = !item.start.dateTime;
        const startIso = item.start.dateTime || item.start.date;
        if (!startIso) continue;

        const startDateObj = new Date(startIso);
        if (isNaN(startDateObj.getTime())) continue;

        const dateOnly = new Date(startDateObj);
        dateOnly.setHours(0, 0, 0, 0);

        const startTime = isAllDay ? null : startDateObj;
        const endTime = item.end?.dateTime ? new Date(item.end.dateTime) : null;

        const existing = await prisma.dailyActivity.findFirst({
          where: { userId, googleEventId: item.id },
        });

        if (existing) {
          // Perbarui data jika ada perubahan di Google Calendar
          await prisma.dailyActivity.update({
            where: { id: existing.id },
            data: {
              title: item.summary || existing.title,
              description: item.description !== undefined ? item.description : existing.description,
              date: dateOnly,
              startTime,
              endTime,
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
            },
          });
          importedCount++;
        }
      }
    }
  } catch (err) {
    console.error('[googleCalendar] autoSyncTwoWay fetch error:', err);
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
    const existing = await prisma.dailyActivity.findFirst({
      where: { userId: req.userId, googleEventId: item.id },
    });

    if (existing) continue;

    const startDate = new Date(item.start);
    if (isNaN(startDate.getTime())) continue;

    const dateOnly = new Date(startDate);
    dateOnly.setHours(0, 0, 0, 0);

    const hasTime = item.start.includes('T');
    const startTime = hasTime ? startDate : null;
    const endTime = item.end && item.end.includes('T') ? new Date(item.end) : null;

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
