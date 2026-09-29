import type { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { sendError } from '../lib/errors';
import { withUserCalendarLock } from '../lib/calendarOperationLock';
import {
  CalendarSyncError,
  calendarRequest,
  autoSyncTwoWay,
  notifyCalendarChangedLocked,
  syncActivityLocked,
  importGoogleEventLocked,
  readGoogleEvent,
  markCalendarChangedLocked,
  changedCalendarFields,
  propagatePersonalActivityLocked,
  queueCalendarDeleteLocked,
  flushCalendarDeleteLocked,
} from '../lib/googleCalendarSync';
import { calendarDate } from '../lib/calendarMerge';
import { Prisma } from '@prisma/client';
import { emitToUser } from '../lib/socket';
import {
  assertConnection,
  currentConnectionId,
  expectedConnection,
} from '../lib/calendarConnection';
export { autoSyncTwoWay, pushActivityToGoogleCalendar } from '../lib/googleCalendarSync';
import {
  GoogleCalendarListError,
  listGoogleEventItems,
  getValidUserToken,
  type GoogleCalendarEventItem,
} from '../lib/googleCalendarClient';

interface GoogleTokenInfo {
  aud?: string;
  sub?: string;
  email?: string;
  expires_in?: string;
}

interface GoogleUserInfo {
  sub?: string;
  email?: string;
  name?: string;
  picture?: string;
}

// ============ Status ============
export async function getStatus(req: Request, res: Response) {
  if (!req.userId) return sendError(res, 401, 'Tidak terautentikasi');

  const connectionId = await currentConnectionId(req.userId);
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
      connectionId,
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
      return sendError(
        res,
        500,
        'GOOGLE_CLIENT_ID atau GOOGLE_CLIENT_SECRET belum dikonfigurasi di server.',
      );
    }

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      signal: AbortSignal.timeout(15000),
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
      { signal: AbortSignal.timeout(15000) },
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
  let subject: string | null = null;

  try {
    const userRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      signal: AbortSignal.timeout(15000),
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (userRes.ok) {
      const userInfo = (await userRes.json()) as GoogleUserInfo;
      subject = userInfo.sub || null;
      email = userInfo.email || null;
      name = userInfo.name || null;
      picture = userInfo.picture || null;
    }
  } catch (err) {
    console.error('[googleCalendar] Gagal mengambil profil Google userinfo:', err);
  }

  if (!subject) return sendError(res, 403, 'Google belum dapat memverifikasi identitas akun.');
  const userId = req.userId;
  return withUserCalendarLock(userId, async () => {
    const connection = await prisma.googleCalendarConnection.upsert({
      where: {
        userId_googleSubject_calendarId: { userId, googleSubject: subject!, calendarId: 'primary' },
      },
      create: { userId, googleSubject: subject!, email },
      update: { email },
    });
    const existing = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const finalRefreshToken =
      refreshToken ||
      (existing.googleCalendarConnectionId === connection.id
        ? existing.googleCalendarRefreshToken
        : null);
    await prisma.user.update({
      where: { id: userId },
      data: {
        googleCalendarConnected: true,
        googleCalendarConnectionId: connection.id,
        googleCalendarAccessToken: accessToken,
        googleCalendarRefreshToken: finalRefreshToken,
        googleCalendarTokenExpiresAt: expiresAt,
        googleCalendarEmail: email,
        googleCalendarName: name,
        googleCalendarAvatarUrl: picture,
        googleCalendarSyncedAt: connection.syncedAt,
      },
    });
    const status = {
      connected: true,
      connectionId: connection.id,
      email,
      name,
      avatarUrl: picture,
      syncedAt: connection.syncedAt,
    };
    emitToUser(userId, 'calendar:connection-changed', status);
    return res.json({ success: true, data: status });
  });
}

// ============ Disconnect ============
export async function disconnect(req: Request, res: Response) {
  if (!req.userId) return sendError(res, 401, 'Tidak terautentikasi');
  const userId = req.userId;
  await withUserCalendarLock(userId, async () => {
    if (expectedConnection(req) !== undefined)
      await assertConnection(userId, expectedConnection(req));
    return prisma.user.update({
      where: { id: userId },
      data: {
        googleCalendarConnected: false,
        googleCalendarConnectionId: null,
        googleCalendarAccessToken: null,
        googleCalendarRefreshToken: null,
        googleCalendarTokenExpiresAt: null,
        googleCalendarEmail: null,
        googleCalendarName: null,
        googleCalendarAvatarUrl: null,
        googleCalendarSyncedAt: null,
      },
    });
  });
  emitToUser(userId, 'calendar:connection-changed', { connected: false, connectionId: null });

  return res.json({
    success: true,
    data: { connected: false, connectionId: null },
  });
}

// ============ List Google Calendar Events ============
export async function listEvents(req: Request, res: Response) {
  if (!req.userId) return sendError(res, 401, 'Tidak terautentikasi');

  const tokenResult = await getValidUserToken(req.userId, expectedConnection(req));
  if ('error' in tokenResult) {
    return sendError(res, tokenResult.code, tokenResult.error);
  }

  const hidden = await prisma.calendarSyncState.findMany({
    where: {
      userId: req.userId,
      calendarConnectionId: tokenResult.connectionId,
      pendingDelete: true,
    },
    select: { googleEventId: true },
  });
  const hiddenIds = new Set(hidden.map((state) => state.googleEventId));

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
      try {
        await calendarRequest(req.userId, '?maxResults=1', {}, tokenResult.connectionId);
        const refreshed = await getValidUserToken(req.userId, expectedConnection(req));
        if ('error' in refreshed) return sendError(res, refreshed.code, refreshed.error);
        items = await listGoogleEventItems(refreshed.accessToken, timeMin, timeMax, 250);
      } catch (retryError) {
        return syncFailure(res, retryError);
      }
    } else {
      console.error('[googleCalendar] gagal mengambil event:', error);
      return sendError(res, 502, 'Gagal mengambil event dari Google Calendar.');
    }
  }

  await assertConnection(req.userId, tokenResult.connectionId);
  const formatted = items
    .filter(
      (item) =>
        item.status !== 'cancelled' &&
        !hiddenIds.has(item.id) &&
        !hiddenIds.has(item.recurringEventId || '') &&
        Boolean(item.start?.dateTime || item.start?.date),
    )
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

  return res.json({ success: true, data: formatted, connectionId: tokenResult.connectionId });
}

function syncFailure(res: Response, error: unknown) {
  return sendError(
    res,
    error instanceof CalendarSyncError ? error.code : 502,
    error instanceof CalendarSyncError ? error.message : 'Sinkronisasi Google Calendar tertunda.',
  );
}

export async function syncActivity(req: Request, res: Response) {
  if (!req.userId) return sendError(res, 401, 'Tidak terautentikasi');
  const userId = req.userId;
  return withUserCalendarLock(userId, async () => {
    const connectionId = await assertConnection(userId, expectedConnection(req));
    const result = await syncActivityLocked(userId, req.params.activityId);
    const activity = await prisma.dailyActivity.findFirst({
      where: { id: req.params.activityId, userId },
      include: { checklistItems: true },
    });
    if (!activity) return sendError(res, 404, 'Aktivitas tidak ditemukan');
    return res.json({
      success: true,
      data: {
        activity,
        connectionId,
        googleEventId: result.googleEventId,
        pending: !result.googleEventId,
      },
    });
  });
}

const syncRangeSchema = z.object({
  startDate: z.string().optional(),
  endDate: z.string().optional(),
});
export async function handleAutoSync(req: Request, res: Response) {
  if (!req.userId) return sendError(res, 401, 'Tidak terautentikasi');
  const body = syncRangeSchema.parse(req.body || {});
  try {
    return res.json({
      success: true,
      data: await autoSyncTwoWay(req.userId, body.startDate, body.endDate, expectedConnection(req)),
    });
  } catch (error) {
    return syncFailure(res, error);
  }
}

const importSchema = z.object({
  events: z.array(
    z.object({
      id: z.string().min(1),
      title: z.string(),
      description: z.string().nullable().optional(),
      start: z.string(),
      end: z.string().optional(),
    }),
  ),
});
export async function importEvents(req: Request, res: Response) {
  if (!req.userId) return sendError(res, 401, 'Tidak terautentikasi');
  const userId = req.userId;
  const body = importSchema.parse(req.body);
  return withUserCalendarLock(userId, async () => {
    const connectionId = await assertConnection(userId, expectedConnection(req));
    let importedCount = 0;
    try {
      // Read authoritative Google data; client text is not an identity or permission check.
      for (const item of body.events) {
        const existing = await prisma.dailyActivity.findFirst({
          where: { userId, calendarConnectionId: connectionId, googleEventId: item.id },
        });
        if (existing) continue;
        const event = await readGoogleEvent(userId, item.id);
        if (event && (await importGoogleEventLocked(userId, event))) importedCount++;
      }
      await notifyCalendarChangedLocked(userId, { action: 'import', importedCount });
      return res.json({ success: true, data: { importedCount } });
    } catch (error) {
      return syncFailure(res, error);
    }
  });
}

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
  const userId = req.userId;
  const body = updateEventSchema.parse(req.body);
  return withUserCalendarLock(userId, async () => {
    const connectionId = await assertConnection(userId, expectedConnection(req));
    try {
      let activity = await prisma.dailyActivity.findFirst({
        where: { userId, calendarConnectionId: connectionId, googleEventId: req.params.eventId },
        include: { checklistItems: true },
      });
      if (!activity) {
        const event = await readGoogleEvent(userId, req.params.eventId);
        if (!event) return sendError(res, 404, 'Event sudah dihapus dari Google Calendar.');
        activity = await importGoogleEventLocked(userId, event);
      }
      if (!activity) return sendError(res, 404, 'Event tidak tersedia.');
      const changes = {
        ...body,
        color: body.colorId,
        ...(body.startTime !== undefined ? { allDay: !body.startTime } : {}),
      };
      const fields = changedCalendarFields(changes, activity);
      await markCalendarChangedLocked(activity, fields);
      const updated = await prisma.dailyActivity.update({
        where: { id: activity.id },
        data: {
          ...(body.title !== undefined ? { title: body.title } : {}),
          ...(body.description !== undefined ? { description: body.description } : {}),
          ...(body.date !== undefined
            ? { date: new Date(`${calendarDate(body.date)}T00:00:00Z`) }
            : {}),
          ...(body.startTime !== undefined
            ? {
                startTime: body.startTime ? new Date(body.startTime) : null,
                allDay: !body.startTime,
              }
            : {}),
          ...(body.endTime !== undefined
            ? { endTime: body.endTime ? new Date(body.endTime) : null }
            : {}),
          ...(body.recurrence !== undefined
            ? {
                recurrence:
                  body.recurrence === null
                    ? Prisma.DbNull
                    : (body.recurrence as Prisma.InputJsonValue),
              }
            : {}),
          ...(body.colorId !== undefined ? { color: body.colorId } : {}),
        },
      });
      await propagatePersonalActivityLocked(updated, fields);
      const result = await syncActivityLocked(userId, activity.id);
      await notifyCalendarChangedLocked(userId, {
        action: 'update',
        activityId: activity.id,
        eventId: result.googleEventId || req.params.eventId,
      });
      return res.json({
        success: true,
        data: {
          id: result.googleEventId || req.params.eventId,
          pending: !result.googleEventId,
          connectionId,
          activity: await prisma.dailyActivity.findUnique({
            where: { id: activity.id },
            include: { checklistItems: true },
          }),
        },
      });
    } catch (error) {
      return syncFailure(res, error);
    }
  });
}

export async function deleteEvent(req: Request, res: Response) {
  if (!req.userId) return sendError(res, 401, 'Tidak terautentikasi');
  const userId = req.userId;
  return withUserCalendarLock(userId, async () => {
    const connectionId = await assertConnection(userId, expectedConnection(req));
    try {
      let activity = await prisma.dailyActivity.findFirst({
        where: { userId, calendarConnectionId: connectionId, googleEventId: req.params.eventId },
      });
      if (!activity) {
        const event = await readGoogleEvent(userId, req.params.eventId);
        if (!event) return res.json({ success: true, data: { id: req.params.eventId } });
        activity = await importGoogleEventLocked(userId, event);
      }
      if (activity) {
        await queueCalendarDeleteLocked(activity);
        const success = await flushCalendarDeleteLocked(userId, activity.id);
        await notifyCalendarChangedLocked(userId, {
          action: 'delete',
          eventId: req.params.eventId,
          activityId: activity.id,
        });
        return res.json({ success: true, data: { id: req.params.eventId, pending: !success } });
      }
      return res.json({ success: true, data: { id: req.params.eventId } });
    } catch (error) {
      return syncFailure(res, error);
    }
  });
}

const createEventSchema = z.object({
  title: z.string().min(1),
  description: z.string().nullable().optional(),
  date: z.string().optional(),
  startTime: z.string().nullable().optional(),
  endTime: z.string().nullable().optional(),
});
export async function createEvent(req: Request, res: Response) {
  if (!req.userId) return sendError(res, 401, 'Tidak terautentikasi');
  const userId = req.userId;
  const body = createEventSchema.parse(req.body);
  if (!body.startTime && !body.date)
    return sendError(res, 422, 'Waktu mulai atau tanggal wajib diisi.');
  return withUserCalendarLock(userId, async () => {
    const connectionId = await assertConnection(userId, expectedConnection(req));
    const activity = await prisma.dailyActivity.create({
      data: {
        userId,
        title: body.title,
        description: body.description,
        date: new Date(`${calendarDate(body.startTime || body.date!)}T00:00:00Z`),
        startTime: body.startTime ? new Date(body.startTime) : null,
        endTime: body.endTime ? new Date(body.endTime) : null,
        allDay: !body.startTime,
      },
    });
    await markCalendarChangedLocked(activity, ['title', 'description', 'start', 'end']);
    const result = await syncActivityLocked(userId, activity.id);
    const state = await prisma.calendarSyncState.findUnique({
      where: { userId_activityId: { userId, activityId: activity.id } },
    });
    await notifyCalendarChangedLocked(userId, {
      action: 'create',
      activityId: activity.id,
      eventId: result.googleEventId,
    });
    return res.status(201).json({
      success: true,
      data: {
        id: result.googleEventId || state?.googleEventId,
        pending: !result.googleEventId,
        connectionId,
        activity: await prisma.dailyActivity.findUnique({
          where: { id: activity.id },
          include: { checklistItems: true },
        }),
      },
    });
  });
}
