import { Prisma, type DailyActivity, type CalendarSyncState } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { prisma } from './prisma';
import { emitToUser } from './socket';
import { withUserCalendarLock } from './calendarOperationLock';
import { assertConnection, currentConnectionId, CalendarSyncError } from './calendarConnection';
export { CalendarSyncError } from './calendarConnection';
import {
  buildGoogleRecurrenceRule,
  getValidUserToken,
  refreshGoogleAccessToken,
  findRecurringInstanceForActivity,
  type GoogleCalendarEventItem,
} from './googleCalendarClient';
import {
  CALENDAR_FIELDS,
  calendarDate,
  nextCalendarDate,
  mergeCalendarValues,
  sameCalendarValue,
  type CalendarChanges,
  type CalendarField,
  type CalendarValues,
} from './calendarMerge';

const json = (value: unknown) => value as Prisma.InputJsonValue;
const eventPath = (id: string) => `/${encodeURIComponent(id)}`;

export async function calendarRequest(
  userId: string,
  path: string,
  init: RequestInit = {},
  expected?: string | null,
) {
  const token = await getValidUserToken(userId, expected);
  if ('error' in token) throw new CalendarSyncError(token.code, token.error);
  const send = (accessToken: string) =>
    fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events${path}`, {
      ...init,
      signal: AbortSignal.timeout(15000),
      headers: {
        ...init.headers,
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    });
  let response = await send(token.accessToken);
  await assertConnection(userId, token.connectionId);
  if (response.status === 401) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { googleCalendarRefreshToken: true },
    });
    const refreshed = user?.googleCalendarRefreshToken
      ? await refreshGoogleAccessToken(userId, user.googleCalendarRefreshToken)
      : null;
    await assertConnection(userId, token.connectionId);
    if (refreshed) response = await send(refreshed);
    await assertConnection(userId, token.connectionId);
    if (response.status === 401) {
      if (user?.googleCalendarRefreshToken && !refreshed) {
        const current = await prisma.user.findUnique({
          where: { id: userId },
          select: { googleCalendarConnected: true },
        });
        if (current?.googleCalendarConnected)
          throw new CalendarSyncError(502, 'Pembaruan sesi Google tertunda. Akan dicoba kembali.');
      } else {
        await prisma.user.updateMany({
          where: { id: userId, googleCalendarConnectionId: token.connectionId },
          data: { googleCalendarConnected: false, googleCalendarAccessToken: null },
        });
      }
      throw new CalendarSyncError(
        403,
        'Sesi Google Calendar kedaluwarsa. Hubungkan ulang akun Google.',
      );
    }
  }
  return response;
}

export async function readGoogleEvent(
  userId: string,
  id: string,
  known?: Pick<CalendarSyncState, 'googleEtag' | 'snapshot'>,
): Promise<GoogleCalendarEventItem | null> {
  const response = await calendarRequest(userId, eventPath(id), {
    headers: known?.googleEtag && known.snapshot ? { 'If-None-Match': known.googleEtag } : {},
  });
  if (response.status === 304 && known?.snapshot) {
    const values = known.snapshot as unknown as CalendarValues;
    const timed = values.start.includes('T');
    return {
      id,
      etag: known.googleEtag || undefined,
      summary: values.title,
      description: values.description + values.checklist,
      colorId: values.color || undefined,
      recurrence: values.recurrence || undefined,
      start: timed ? { dateTime: values.start } : { date: values.start },
      end: timed ? { dateTime: values.end } : { date: values.end },
    };
  }
  if (response.status === 404 || response.status === 410) return null;
  if (!response.ok) throw new CalendarSyncError(502, 'Gagal membaca event Google Calendar.');
  const event = (await response.json()) as GoogleCalendarEventItem;
  return event.status === 'cancelled' ? null : event;
}

type ActivityWithChecklist = DailyActivity & {
  checklistItems?: { text: string; completed: boolean }[];
};

export function calculateRecurrenceStartDayOffset(
  anchorDateStr: string,
  rawRecurrence: unknown,
): number {
  if (!rawRecurrence || typeof rawRecurrence !== 'object') return 0;
  const rec = rawRecurrence as {
    freq?: string;
    byDays?: number[];
    isException?: boolean;
  };
  if (rec.isException || !rec.freq) return 0;

  const [y, m, d] = anchorDateStr.split('-').map(Number);
  const anchorDateUtc = new Date(Date.UTC(y, m - 1, d));
  const dayOfWeek = anchorDateUtc.getUTCDay(); // 0 = Sunday, 1 = Monday, ...

  if (rec.freq === 'WEEKLY' && Array.isArray(rec.byDays) && rec.byDays.length > 0) {
    const validDays = rec.byDays.filter((val) => Number.isInteger(val) && val >= 0 && val <= 6);
    if (validDays.length > 0 && !validDays.includes(dayOfWeek)) {
      for (let offset = 1; offset <= 7; offset++) {
        if (validDays.includes((dayOfWeek + offset) % 7)) {
          return offset;
        }
      }
    }
  }

  return 0;
}

export function activityCalendarValues(activity: ActivityWithChecklist): CalendarValues {
  const baseDateStr = calendarDate(activity.startTime ?? activity.date);
  const offsetDays = calculateRecurrenceStartDayOffset(baseDateStr, activity.recurrence);

  let start: string;
  let end: string;

  if (offsetDays > 0) {
    if (activity.startTime) {
      const shiftedStartTime = new Date(activity.startTime.getTime() + offsetDays * 86400000);
      const duration =
        activity.endTime && activity.endTime > activity.startTime
          ? activity.endTime.getTime() - activity.startTime.getTime()
          : 3600000;
      const shiftedEndTime = new Date(shiftedStartTime.getTime() + duration);
      start = shiftedStartTime.toISOString();
      end = shiftedEndTime.toISOString();
    } else {
      const [y, m, d] = baseDateStr.split('-').map(Number);
      const shiftedUtc = new Date(Date.UTC(y, m - 1, d + offsetDays));
      start = shiftedUtc.toISOString().slice(0, 10);
      end = nextCalendarDate(start);
    }
  } else {
    start = activity.startTime?.toISOString() ?? calendarDate(activity.date);
    end = activity.startTime
      ? (activity.endTime && activity.endTime > activity.startTime
          ? activity.endTime
          : new Date(activity.startTime.getTime() + 3600000)
        ).toISOString()
      : nextCalendarDate(start);
  }

  return {
    title: activity.title,
    description: activity.description || '',
    start,
    end,
    color: activity.color && /^(?:[1-9]|10|11)$/.test(activity.color) ? activity.color : null,
    recurrence: buildGoogleRecurrenceRule(activity.recurrence),
    checklist: activity.checklistItems?.length
      ? '\n\nChecklist:\n' +
        activity.checklistItems
          .map((item) => `${item.completed ? '[x]' : '[ ]'} ${item.text}`)
          .join('\n')
      : '',
  };
}

export function googleCalendarValues(
  event: GoogleCalendarEventItem,
  baseline?: CalendarValues | null,
): CalendarValues {
  let description = event.description || '';
  const checklist = baseline?.checklist || '';
  if (checklist && description.endsWith(checklist))
    description = description.slice(0, -checklist.length);
  const start = event.start?.dateTime
    ? new Date(event.start.dateTime).toISOString()
    : event.start?.date;
  if (!start) throw new CalendarSyncError(502, 'Event Google tidak memiliki waktu mulai.');
  const end = event.end?.dateTime
    ? new Date(event.end.dateTime).toISOString()
    : event.end?.date ||
      (start.includes('T')
        ? new Date(new Date(start).getTime() + 3600000).toISOString()
        : nextCalendarDate(start));
  return {
    title: event.summary || '(Tanpa judul)',
    description,
    start,
    end,
    color: event.colorId || null,
    recurrence: event.recurrence?.length ? event.recurrence : null,
    checklist,
  };
}

function eventPayload(values: CalendarValues, activityId: string, patch = false) {
  const timed = values.start.includes('T');
  const time = (value: string) =>
    timed
      ? { dateTime: value, timeZone: 'Asia/Jakarta', ...(patch ? { date: null } : {}) }
      : { date: value, ...(patch ? { dateTime: null } : {}) };
  return {
    summary: values.title,
    description: values.description + values.checklist,
    start: time(values.start),
    end: time(values.end),
    colorId: values.color,
    recurrence: values.recurrence || [],
    extendedProperties: { private: { purrificActivityId: activityId } },
  };
}

function recurrenceConfig(rules: string[] | null): Prisma.InputJsonValue | typeof Prisma.DbNull {
  const rule = rules?.find((value) => value.startsWith('RRULE:'));
  if (!rule) return Prisma.DbNull;
  const parts: Record<string, string> = Object.fromEntries(
    rule
      .slice(6)
      .split(';')
      .map((value) => value.split('=')),
  );
  if (!['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(parts.FREQ)) return Prisma.DbNull;
  const result: Record<string, unknown> = {
    freq: parts.FREQ,
    interval: Number(parts.INTERVAL) || 1,
    endType: 'NEVER',
  };
  const days = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
  if (parts.WKST) result.weekStartsOn = days.indexOf(parts.WKST);
  if (parts.BYDAY) {
    const monthly = /^(-?\d)(SU|MO|TU|WE|TH|FR|SA)$/.exec(parts.BYDAY);
    if (monthly)
      result.byWeekOfMonth = { week: Number(monthly[1]), dayOfWeek: days.indexOf(monthly[2]) };
    else
      result.byDays = parts.BYDAY.split(',')
        .map((day) => days.indexOf(day))
        .filter((day) => day >= 0);
  }
  if (parts.BYMONTHDAY) result.byMonthDay = Number(parts.BYMONTHDAY);
  if (parts.COUNT) {
    result.endType = 'AFTER';
    result.count = Number(parts.COUNT);
  } else if (parts.UNTIL) {
    result.endType = 'ON_DATE';
    result.untilDate = `${parts.UNTIL.slice(0, 4)}-${parts.UNTIL.slice(4, 6)}-${parts.UNTIL.slice(6, 8)}`;
  }
  return json(result);
}

export function recurrenceDisplayConfig(rules: string[] | null): Prisma.InputJsonValue | null {
  const recurrenceRules = rules?.filter(rule => rule.startsWith('RRULE:')) || [];
  if (recurrenceRules.length !== 1 || rules?.some(rule => !/^(RRULE:|EXDATE[;:])/.test(rule))) return null;
  const entries = recurrenceRules[0].slice(6).split(';').map(part => part.split('='));
  const supported = new Set(['FREQ', 'INTERVAL', 'COUNT', 'UNTIL', 'BYDAY', 'BYMONTHDAY', 'WKST']);
  if (entries.some(([key, value]) => !supported.has(key) || !value)) return null;
  const parts: Record<string, string> = Object.fromEntries(entries);
  if (Object.keys(parts).length !== entries.length) return null;
  for (const key of ['INTERVAL', 'COUNT']) {
    if (parts[key] && (!Number.isInteger(Number(parts[key])) || Number(parts[key]) < 1)) return null;
  }
  if (parts.COUNT && parts.UNTIL) return null;
  if (parts.WKST && !/^(SU|MO|TU|WE|TH|FR|SA)$/.test(parts.WKST)) return null;
  if (parts.UNTIL && !/^\d{8}(T\d{6}Z)?$/.test(parts.UNTIL)) return null;
  if (parts.BYDAY) {
    const weekly = parts.FREQ === 'WEEKLY' && /^(SU|MO|TU|WE|TH|FR|SA)(,(SU|MO|TU|WE|TH|FR|SA))*$/.test(parts.BYDAY);
    const monthly = parts.FREQ === 'MONTHLY' && /^(-1|[1-5])(SU|MO|TU|WE|TH|FR|SA)$/.test(parts.BYDAY);
    if (!weekly && !monthly) return null;
  }
  if (parts.BYMONTHDAY && (parts.FREQ !== 'MONTHLY' || parts.BYDAY ||
    !Number.isInteger(Number(parts.BYMONTHDAY)) || Number(parts.BYMONTHDAY) < 1 || Number(parts.BYMONTHDAY) > 31)) return null;
  const parsed = recurrenceConfig(rules);
  return parsed === Prisma.DbNull ? null : parsed as Prisma.InputJsonValue;
}

export async function ensureCalendarStateLocked(activity: ActivityWithChecklist, mutation = false) {
  // Unknown legacy links stay quarantined until Google's event confirms ownership.
  let connectionId = activity.calendarConnectionId;
  if (!connectionId && !activity.googleEventId && (activity.startTime || activity.allDay)) {
    const previous = await prisma.calendarSyncState.findUnique({
      where: { userId_activityId: { userId: activity.userId, activityId: activity.id } },
    });
    connectionId = previous?.googleEventId
      ? previous.calendarConnectionId
      : await currentConnectionId(activity.userId);
    if (connectionId)
      await prisma.dailyActivity.update({
        where: { id: activity.id },
        data: { calendarConnectionId: connectionId },
      });
  }
  const state = await prisma.calendarSyncState.upsert({
    where: { userId_activityId: { userId: activity.userId, activityId: activity.id } },
    create: {
      userId: activity.userId,
      activityId: activity.id,
      googleEventId: activity.googleEventId,
      calendarConnectionId: connectionId,
      ...(mutation ? { snapshot: json(activityCalendarValues(activity)) } : {}),
    },
    update: connectionId ? { calendarConnectionId: connectionId } : {},
  });
  if (mutation && !state.snapshot) {
    return prisma.calendarSyncState.update({
      where: { id: state.id },
      data: { snapshot: json(activityCalendarValues(activity)) },
    });
  }
  return state;
}

export async function markCalendarChangedLocked(
  activity: ActivityWithChecklist,
  fields: readonly CalendarField[],
  at = new Date().toISOString(),
) {
  if (!fields.length) return;
  const state = await ensureCalendarStateLocked(activity, true);
  const changes = { ...(state.localChanges as CalendarChanges | null) };
  for (const field of fields) changes[field] = at;
  await prisma.calendarSyncState.update({
    where: { id: state.id },
    data: { localChanges: json(changes), pending: true, lastError: null },
  });
}

export function changedCalendarFields(
  body: Record<string, unknown>,
  activity?: DailyActivity,
): CalendarField[] {
  const fields: CalendarField[] = [];
  for (const [key, field] of Object.entries({
    title: 'title',
    description: 'description',
    date: 'start',
    startTime: 'start',
    endTime: 'end',
    color: 'color',
    recurrence: 'recurrence',
    allDay: 'start',
  })) {
    if (body[key] === undefined) continue;
    if (activity) {
      if (key === 'date' && calendarDate(String(body.date)) === calendarDate(activity.date))
        continue;
      if (key === 'startTime' || key === 'endTime') {
        const previous = activity[key]?.toISOString() || null;
        const next = body[key] ? new Date(String(body[key])).toISOString() : null;
        if (previous === next) continue;
      } else if (
        key !== 'date' &&
        sameCalendarValue(body[key], activity[key as keyof DailyActivity])
      )
        continue;
    }
    fields.push(field as CalendarField);
  }
  if (fields.includes('start') && (body.date !== undefined || body.allDay !== undefined))
    fields.push('end');
  return [...new Set(fields)];
}

export async function propagatePersonalActivityLocked(
  activity: DailyActivity,
  fields: readonly CalendarField[],
  at = new Date().toISOString(),
) {
  if (!activity.taskId || !fields.some((field) => field === 'title' || field === 'description'))
    return;
  const task = await prisma.task.findFirst({
    where: { id: activity.taskId, project: { teamId: `personal-${activity.userId}` } },
  });
  if (!task) return;
  const data = {
    ...(fields.includes('title') ? { title: activity.title } : {}),
    ...(fields.includes('description') ? { description: activity.description } : {}),
  };
  const changed =
    (data.title !== undefined && data.title !== task.title) ||
    (data.description !== undefined && data.description !== task.description);
  if (changed) {
    await prisma.task.update({ where: { id: task.id }, data });
    emitToUser(activity.userId, 'task:updated', {
      taskId: task.id,
      projectId: task.projectId,
      action: 'UPDATED',
    });
  }
  const siblings = await prisma.dailyActivity.findMany({
    where: { userId: activity.userId, taskId: task.id, id: { not: activity.id } },
    include: { checklistItems: true },
  });
  for (const sibling of siblings) {
    if (
      (data.title === undefined || data.title === sibling.title) &&
      (data.description === undefined || data.description === sibling.description)
    )
      continue;
    await markCalendarChangedLocked(
      sibling,
      fields.filter((field) => field === 'title' || field === 'description'),
      at,
    );
    await prisma.dailyActivity.update({ where: { id: sibling.id }, data });
  }
}

export async function propagatePersonalTaskLocked(
  userId: string,
  taskId: string,
  body: { title?: string; description?: string | null },
) {
  const task = await prisma.task.findFirst({
    where: { id: taskId, project: { teamId: `personal-${userId}` } },
  });
  if (!task) return;
  const fields = changedCalendarFields(body);
  if (!fields.length) return;
  const activities = await prisma.dailyActivity.findMany({
    where: { userId, taskId },
    include: { checklistItems: true },
  });
  for (const activity of activities) {
    await markCalendarChangedLocked(activity, fields);
    await prisma.dailyActivity.update({ where: { id: activity.id }, data: body });
  }
  for (const activity of activities) await syncActivityLocked(userId, activity.id);
  if (activities.length) await notifyCalendarChangedLocked(userId, { action: 'update', taskId });
}

export async function notifyCalendarChangedLocked(
  userId: string,
  payload: Record<string, unknown>,
) {
  const connectionId = await currentConnectionId(userId);
  const pendingCount = await prisma.calendarSyncState.count({
    where: { userId, calendarConnectionId: connectionId, pending: true },
  });
  const activity =
    typeof payload.activityId === 'string'
      ? await prisma.dailyActivity.findFirst({
          where: { id: payload.activityId, userId },
          include: { checklistItems: { orderBy: { order: 'asc' } } },
        })
      : null;
  emitToUser(userId, 'calendar:synced', { ...payload, connectionId, pendingCount, activity });
  return { connectionId, pendingCount, activity };
}

async function applyCalendarValuesLocked(
  activity: ActivityWithChecklist,
  values: CalendarValues,
  eventId: string,
  at?: string,
) {
  const before = activityCalendarValues(activity);
  const fields = CALENDAR_FIELDS.filter(
    (field) => !sameCalendarValue(before[field], values[field]),
  );
  if (!fields.length && activity.googleEventId === eventId) return false;
  const timed = values.start.includes('T');
  const existingRec = activity.recurrence as Record<string, unknown> | null;
  let nextRec: Prisma.InputJsonValue | typeof Prisma.DbNull = recurrenceConfig(values.recurrence);
  if (existingRec?.isException) {
    nextRec = existingRec as unknown as Prisma.InputJsonValue;
  } else if (
    nextRec &&
    nextRec !== Prisma.DbNull &&
    typeof nextRec === 'object' &&
    Array.isArray(existingRec?.excludeDates)
  ) {
    (nextRec as Record<string, unknown>).excludeDates = existingRec.excludeDates;
  }
  const updated = await prisma.dailyActivity.update({
    where: { id: activity.id },
    data: {
      title: values.title,
      description: values.description || null,
      date: new Date(`${calendarDate(values.start)}T00:00:00Z`),
      startTime: timed ? new Date(values.start) : null,
      endTime: timed ? new Date(values.end) : null,
      allDay: !timed,
      color: values.color,
      recurrence: nextRec,
      googleEventId: eventId,
    },
  });
  await propagatePersonalActivityLocked(updated, fields, at);
  return fields.length > 0;
}

export async function queueCalendarDeleteLocked(activity: DailyActivity) {
  const state = await ensureCalendarStateLocked(activity);
  // Retain the allocated ID even if the original create response was lost.
  await prisma.$transaction([
    prisma.calendarSyncState.update({
      where: { id: state.id },
      data: {
        googleEventId: activity.googleEventId || state.googleEventId,
        pendingDelete: true,
        pending: Boolean(activity.googleEventId || state.googleEventId),
        lastError: null,
      },
    }),
    prisma.dailyActivity.deleteMany({ where: { id: activity.id, userId: activity.userId } }),
  ]);
}

export async function detachCalendarScheduleLocked(activity: DailyActivity) {
  const state = await ensureCalendarStateLocked(activity);
  const eventId = activity.googleEventId || state.googleEventId;
  if (eventId) {
    await prisma.calendarSyncState.update({
      where: { id: state.id },
      data: {
        activityId: `${activity.id}:delete:${eventId}`,
        googleEventId: eventId,
        pendingDelete: true,
        pending: true,
      },
    });
    await flushCalendarDeleteLocked(activity.userId, `${activity.id}:delete:${eventId}`);
  } else {
    await prisma.calendarSyncState.delete({ where: { id: state.id } });
  }
  await prisma.dailyActivity.update({
    where: { id: activity.id },
    data: { googleEventId: null, calendarConnectionId: null },
  });
}

export async function flushCalendarDeleteLocked(userId: string, activityId: string) {
  const state = await prisma.calendarSyncState.findUnique({
    where: { userId_activityId: { userId, activityId } },
  });
  if (!state?.pendingDelete || !state.pending || !state.googleEventId) return true;
  if (
    !state.calendarConnectionId ||
    state.calendarConnectionId !== (await currentConnectionId(userId))
  )
    return false;
  try {
    const response = await calendarRequest(
      userId,
      eventPath(state.googleEventId),
      {
        method: 'DELETE',
      },
      state.calendarConnectionId,
    );
    if (!response.ok && response.status !== 404 && response.status !== 410)
      throw new Error('Google Calendar belum dapat menghapus event.');
    await prisma.calendarSyncState.update({
      where: { id: state.id },
      data: { pending: false, lastError: null },
    });
    return true;
  } catch {
    await prisma.calendarSyncState.update({
      where: { id: state.id },
      data: { lastError: 'Penghapusan menunggu sinkronisasi.' },
    });
    return false;
  }
}

export async function deletePersonalTaskSchedulesLocked(userId: string, taskId: string) {
  const task = await prisma.task.findFirst({
    where: { id: taskId, project: { teamId: `personal-${userId}` } },
  });
  if (!task) return;
  const activities = await prisma.dailyActivity.findMany({ where: { userId, taskId } });
  for (const activity of activities) await queueCalendarDeleteLocked(activity);
  for (const activity of activities) {
    await flushCalendarDeleteLocked(userId, activity.id);
    await notifyCalendarChangedLocked(userId, {
      action: 'delete',
      activityId: activity.id,
      googleEventId: activity.googleEventId,
    });
  }
}

interface SyncOneResult {
  googleEventId: string | null;
  updated: boolean;
  deleted: boolean;
  pushed: boolean;
}

export async function syncActivityLocked(
  userId: string,
  activityId: string,
  suppliedRemote?: GoogleCalendarEventItem | null,
  unexcludedDates?: string[],
): Promise<SyncOneResult> {
  const result: SyncOneResult = {
    googleEventId: null,
    updated: false,
    deleted: false,
    pushed: false,
  };
  const activity = await prisma.dailyActivity.findFirst({
    where: { id: activityId, userId },
    include: { checklistItems: { orderBy: { order: 'asc' } } },
  });
  if (!activity) return result;
  const state = await ensureCalendarStateLocked(activity);
  if (state.pendingDelete || (!activity.startTime && !activity.allDay && !activity.googleEventId))
    return result;
  if (
    !state.calendarConnectionId ||
    state.calendarConnectionId !== (await currentConnectionId(userId))
  )
    return result;
  const id = activity.googleEventId || state.googleEventId || randomUUID().replace(/-/g, '');
  const local = activityCalendarValues(activity);
  const baseline = state.snapshot as unknown as CalendarValues | null;
  const changes = state.localChanges as CalendarChanges | null;
  if (baseline && activity.allDay && !activity.startTime && !changes?.start && !changes?.end) {
    local.end = baseline.end;
  }
  // Keep Google's full recurrence rule, including EXDATE/unsupported rule parts,
  // when the user only changed another property.
  if (baseline && !changes?.recurrence) local.recurrence = baseline.recurrence;
  try {
    // Save the chosen ID BEFORE insert, so a timed-out create can be recovered.
    if (!state.googleEventId)
      await prisma.calendarSyncState.update({
        where: { id: state.id },
        data: { googleEventId: id, pending: !activity.googleEventId },
      });
    let remote =
      suppliedRemote === null || suppliedRemote?.id === id
        ? suppliedRemote
        : await readGoogleEvent(userId, id, state);
    if (remote?.status === 'cancelled') remote = null;
    if (!remote && (activity.googleEventId || baseline)) {
      if (activity.googleEventId) {
        await queueCalendarDeleteLocked(activity);
        await prisma.calendarSyncState.update({
          where: { id: state.id },
          data: { pending: false },
        });
        result.deleted = true;
        await notifyCalendarChangedLocked(userId, {
          action: 'delete',
          activityId,
          googleEventId: id,
        });
        return result;
      }
      // A baseline on a NEW local activity is not proof it ever existed remotely.
    }
    if (!remote) {
      const response = await calendarRequest(userId, '', {
        method: 'POST',
        body: JSON.stringify({ id, ...eventPayload(local, activity.id) }),
      });
      if (response.status === 409) remote = await readGoogleEvent(userId, id);
      else if (response.ok) remote = (await response.json()) as GoogleCalendarEventItem;
      else throw new Error('Google Calendar belum dapat membuat event.');
      if (!remote) throw new Error('Event Google belum dapat dibaca.');
      result.pushed = true;
    }
    let merged: CalendarValues = local;
    for (let attempt = 0; attempt < 3; attempt++) {
      const remoteValues = googleCalendarValues(remote, baseline);
      // An existing link without state is initialized from Google, never blindly overwritten.
      merged = baseline
        ? mergeCalendarValues(
            baseline,
            local,
            remoteValues,
            (state.localChanges as CalendarChanges) || {},
            remote.updated,
          )
        : state.pending
          ? local
          : remoteValues;
      if (!sameCalendarValue(merged, remoteValues)) {
        const response = await calendarRequest(userId, eventPath(id), {
          method: 'PATCH',
          headers: remote.etag ? { 'If-Match': remote.etag } : {},
          body: JSON.stringify({
            ...eventPayload(merged, activity.id, true),
            extendedProperties: {
              private: { ...remote.extendedProperties?.private, purrificActivityId: activity.id },
            },
          }),
        });
        if (response.status === 412) {
          const latest = await readGoogleEvent(userId, id);
          if (!latest) throw new Error('Event dihapus saat diperbarui.');
          remote = latest;
          if (attempt === 2)
            throw new Error('Event masih berubah. Sinkronisasi akan dicoba kembali.');
          continue;
        }
        if (response.status === 404 || response.status === 410) {
          await queueCalendarDeleteLocked(activity);
          await prisma.calendarSyncState.update({
            where: { id: state.id },
            data: { pending: false },
          });
          result.deleted = true;
          return result;
        }
        if (!response.ok) throw new Error('Google Calendar belum dapat memperbarui event.');
        remote = (await response.json()) as GoogleCalendarEventItem;
        result.pushed = true;
      }
      // Keep the semantic description separate from the generated checklist text.
      if (
        !result.pushed &&
        !state.pending &&
        state.snapshot &&
        state.googleEtag === remote.etag &&
        sameCalendarValue(local, merged) &&
        activity.googleEventId === id
      ) {
        result.googleEventId = id;
        await syncRecurrenceExceptionsLocked(userId, activity, id, unexcludedDates);
        return result;
      }
      result.updated = await applyCalendarValuesLocked(activity, merged, id, remote.updated);
      await prisma.calendarSyncState.update({
        where: { id: state.id },
        data: {
          googleEventId: id,
          snapshot: json(merged),
          localChanges: {},
          googleEtag: remote.etag,
          recurringEventId: remote.recurringEventId || null,
          pending: false,
          lastError: null,
        },
      });
      result.googleEventId = id;
      await syncRecurrenceExceptionsLocked(userId, activity, id, unexcludedDates);
      return result;
    }
  } catch (error) {
    await prisma.calendarSyncState.update({
      where: { id: state.id },
      data: {
        pending: true,
        lastError:
          error instanceof CalendarSyncError ? error.message : 'Perubahan menunggu sinkronisasi.',
      },
    });
  }
  return result;
}

export async function syncRecurrenceExceptionsLocked(
  userId: string,
  activity: DailyActivity,
  googleEventId?: string | null,
  unexcludedDates?: string[],
) {
  const eventId = googleEventId || activity.googleEventId;
  if (!eventId) return;

  const currentAct = await prisma.dailyActivity.findUnique({
    where: { id: activity.id },
  });
  const rec = (currentAct?.recurrence || activity.recurrence) as unknown as {
    freq?: string;
    excludeDates?: string[];
    isException?: boolean;
  } | null;

  if (!rec || rec.isException) return;

  const excludeDates = Array.isArray(rec.excludeDates)
    ? rec.excludeDates.filter((d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d.trim()))
    : [];

  const toRestore = Array.isArray(unexcludedDates)
    ? unexcludedDates.filter((d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d.trim()))
    : [];

  if (excludeDates.length === 0 && toRestore.length === 0) return;

  let tokenInfo;
  try {
    tokenInfo = await getValidUserToken(userId);
  } catch {
    return;
  }
  if (!tokenInfo || 'error' in tokenInfo || !tokenInfo.accessToken) return;

  // 1. Batalkan (cancel) instance yang masuk ke excludeDates
  for (const dateStr of excludeDates) {
    const trimmed = dateStr.trim();
    const targetDate = new Date(`${trimmed}T00:00:00Z`);
    let instanceStart: Date | null = null;
    if (activity.startTime) {
      const orig = new Date(activity.startTime);
      instanceStart = new Date(
        Date.UTC(
          targetDate.getUTCFullYear(),
          targetDate.getUTCMonth(),
          targetDate.getUTCDate(),
          orig.getUTCHours(),
          orig.getUTCMinutes(),
          orig.getUTCSeconds(),
        ),
      );
    }
    try {
      const instance = await findRecurringInstanceForActivity(
        tokenInfo.accessToken,
        eventId,
        targetDate,
        instanceStart,
        trimmed,
      );
      if (instance && instance.status !== 'cancelled') {
        await calendarRequest(userId, eventPath(instance.id), { method: 'DELETE' });
      }
    } catch {
      // Abaikan kegagalan instance delete sementara agar sinkronisasi utama tetap sukses
    }
  }

  // 2. Pulihkan (restore / un-cancel) instance yang dikeluarkan dari excludeDates (misal saat Undo Ctrl+Z)
  for (const dateStr of toRestore) {
    const trimmed = dateStr.trim();
    const targetDate = new Date(`${trimmed}T00:00:00Z`);
    let instanceStart: Date | null = null;
    if (activity.startTime) {
      const orig = new Date(activity.startTime);
      instanceStart = new Date(
        Date.UTC(
          targetDate.getUTCFullYear(),
          targetDate.getUTCMonth(),
          targetDate.getUTCDate(),
          orig.getUTCHours(),
          orig.getUTCMinutes(),
          orig.getUTCSeconds(),
        ),
      );
    }
    try {
      const instance = await findRecurringInstanceForActivity(
        tokenInfo.accessToken,
        eventId,
        targetDate,
        instanceStart,
        trimmed,
      );
      if (instance && instance.status === 'cancelled') {
        await calendarRequest(userId, eventPath(instance.id), {
          method: 'PATCH',
          body: JSON.stringify({ status: 'confirmed' }),
        });
      }
    } catch {
      // Abaikan kegagalan instance restore sementara agar sinkronisasi utama tetap sukses
    }
  }
}

export async function pushActivityToGoogleCalendar(userId: string, activityId: string) {
  return withUserCalendarLock(
    userId,
    async () => (await syncActivityLocked(userId, activityId)).googleEventId,
  );
}

export async function importGoogleEventLocked(
  userId: string,
  event: GoogleCalendarEventItem,
  knownNew = false,
) {
  if (event.status === 'cancelled' || !event.start) return null;
  const connectionId = await currentConnectionId(userId);
  if (!connectionId) return null;

  if (event.recurringEventId && !event.recurrence?.length) {
    const existingMaster = await prisma.dailyActivity.findFirst({
      where: { userId, calendarConnectionId: connectionId, googleEventId: event.recurringEventId },
      include: { checklistItems: true },
    });
    if (existingMaster) return existingMaster;
    const master = await readGoogleEvent(userId, event.recurringEventId);
    if (master && master.status !== 'cancelled' && master.start) {
      return importGoogleEventLocked(userId, master, knownNew);
    }
  }

  if (!knownNew) {
    const tombstone = await prisma.calendarSyncState.findFirst({
      where: {
        userId,
        calendarConnectionId: connectionId,
        googleEventId: event.id,
        pendingDelete: true,
      },
    });
    if (tombstone) return null;
    let activity = await prisma.dailyActivity.findFirst({
      where: { userId, calendarConnectionId: connectionId, googleEventId: event.id },
      include: { checklistItems: true },
    });
    if (!activity && event.extendedProperties?.private?.purrificActivityId) {
      const candidate = await prisma.dailyActivity.findFirst({
        where: {
          userId,
          id: event.extendedProperties.private.purrificActivityId,
          googleEventId: null,
        },
        include: { checklistItems: true },
      });
      if (candidate) {
        const state = await prisma.calendarSyncState.findUnique({
          where: { userId_activityId: { userId, activityId: candidate.id } },
        });
        if (
          state?.calendarConnectionId === connectionId &&
          state.googleEventId === event.id &&
          !state.pendingDelete
        )
          activity = candidate;
      }
    }
    if (activity) return activity;
  }
  const values = googleCalendarValues(event);
  const timed = values.start.includes('T');
  const activity = await prisma.dailyActivity.create({
    data: {
      userId,
      calendarConnectionId: connectionId,
      title: values.title,
      description: values.description || null,
      date: new Date(`${calendarDate(values.start)}T00:00:00Z`),
      startTime: timed ? new Date(values.start) : null,
      endTime: timed ? new Date(values.end) : null,
      allDay: !timed,
      googleEventId: event.id,
      color: values.color,
      type: 'CUSTOM',
      recurrence: values.recurrence
        ? recurrenceConfig(values.recurrence)
        : event.recurringEventId
          ? { isException: true }
          : Prisma.DbNull,
      status: 'PENDING',
    },
    include: { checklistItems: true },
  });
  await prisma.calendarSyncState.create({
    data: {
      userId,
      activityId: activity.id,
      googleEventId: event.id,
      calendarConnectionId: connectionId,
      recurringEventId: event.recurringEventId,
      snapshot: json(values),
      googleEtag: event.etag,
    },
  });

  if (values.recurrence && values.recurrence.length > 0) {
    const looseStates = await prisma.calendarSyncState.findMany({
      where: {
        userId,
        calendarConnectionId: connectionId,
        recurringEventId: event.id,
        activityId: { not: activity.id },
      },
    });
    for (const state of looseStates) {
      await prisma.calendarSyncState.deleteMany({ where: { id: state.id } });
      await prisma.dailyActivity.deleteMany({
        where: { id: state.activityId, userId, googleEventId: state.googleEventId },
      });
    }
    const looseActs = await prisma.dailyActivity.findMany({
      where: {
        userId,
        calendarConnectionId: connectionId,
        id: { not: activity.id },
        googleEventId: { startsWith: `${event.id}_` },
      },
    });
    for (const act of looseActs) {
      await prisma.calendarSyncState.deleteMany({ where: { activityId: act.id } });
      await prisma.dailyActivity.deleteMany({ where: { id: act.id } });
    }
  }

  return activity;
}

export async function consolidateLooseGoogleRecurringActivities(userId: string) {
  const allWithGoogleId = await prisma.dailyActivity.findMany({
    where: {
      userId,
      googleEventId: { not: null },
    },
    orderBy: { date: 'asc' },
  });
  const looseActivities = allWithGoogleId.filter(
    (act) => act.googleEventId && act.googleEventId.includes('_'),
  );
  if (!looseActivities.length) return;

  const groups = new Map<string, typeof looseActivities>();
  for (const act of looseActivities) {
    if (!act.googleEventId) continue;
    const baseId = act.googleEventId.split('_')[0];
    if (!baseId) continue;
    const list = groups.get(baseId) || [];
    list.push(act);
    groups.set(baseId, list);
  }

  for (const [baseId, acts] of groups.entries()) {
    let masterAct = await prisma.dailyActivity.findFirst({
      where: {
        userId,
        googleEventId: baseId,
      },
    });

    let googleMaster: GoogleCalendarEventItem | null = null;
    try {
      googleMaster = await readGoogleEvent(userId, baseId);
    } catch {
      // Abaikan kegagalan jaringan
    }

    let parsedRecurrence: Prisma.InputJsonValue | null = null;
    if (googleMaster?.recurrence?.length) {
      parsedRecurrence = recurrenceDisplayConfig(googleMaster.recurrence);
    }

    if (googleMaster && googleMaster.status !== 'cancelled' && googleMaster.start) {
      if (!masterAct) {
        masterAct = await importGoogleEventLocked(userId, googleMaster, true);
      } else if (parsedRecurrence && (!masterAct.recurrence || (masterAct.recurrence as Record<string, unknown>).isException)) {
        masterAct = await prisma.dailyActivity.update({
          where: { id: masterAct.id },
          data: { recurrence: parsedRecurrence },
        });
      }
    } else if (!masterAct && acts.length > 0) {
      const first = acts[0];
      const fallbackRec = parsedRecurrence || { freq: 'DAILY', interval: 1, endType: 'NEVER' };
      masterAct = await prisma.dailyActivity.update({
        where: { id: first.id },
        data: {
          googleEventId: baseId,
          recurrence: fallbackRec as Prisma.InputJsonValue,
        },
      });
    }

    if (masterAct) {
      const deleteIds = acts
        .filter((a) => a.id !== masterAct?.id)
        .map((a) => a.id);

      if (deleteIds.length > 0) {
        await prisma.calendarSyncState.deleteMany({
          where: { activityId: { in: deleteIds } },
        });
        await prisma.dailyActivity.deleteMany({
          where: { id: { in: deleteIds } },
        });
      }
    }
  }
}

type SyncResult = {
  syncRunId: string;
  connectionId: string;
  pushedCount: number;
  importedCount: number;
  updatedCount: number;
  deletedCount: number;
  pendingCount: number;
  syncedAt: string | null;
  baselinePending?: boolean;
};
interface SyncFlight {
  rangeKey: string;
  hydrateRange: boolean;
  promise: Promise<SyncResult>;
}
const syncFlights = new Map<string, SyncFlight>();
const baselines = new Map<string, Promise<void>>();

function emptyResult(connectionId: string): SyncResult {
  return {
    syncRunId: randomUUID(),
    connectionId,
    pushedCount: 0,
    importedCount: 0,
    updatedCount: 0,
    deletedCount: 0,
    pendingCount: 0,
    syncedAt: null,
  };
}

// Batch lookups are limited to the IDs in Google's delta; unchanged schedules are never scanned.
async function applyEventPage(
  userId: string,
  connectionId: string,
  items: GoogleCalendarEventItem[],
  result: SyncResult,
  window?: { start: Date; end: Date },
) {
  if (!items.length) return;
  if (items.length > 25) {
    for (let offset = 0; offset < items.length; offset += 25)
      await applyEventPage(userId, connectionId, items.slice(offset, offset + 25), result, window);
    return;
  }
  const instances: { activityId: string; eventId: string; cancelled: boolean }[] = [];
  await withUserCalendarLock(userId, async () => {
    await assertConnection(userId, connectionId);
    const ids = [
      ...new Set(items.flatMap((e) => [e.id, ...(e.recurringEventId ? [e.recurringEventId] : [])])),
    ];
    const states = await prisma.calendarSyncState.findMany({
      where: {
        userId,
        OR: [{ calendarConnectionId: connectionId }, { calendarConnectionId: null }],
        AND: [{ OR: [{ googleEventId: { in: ids } }, { recurringEventId: { in: ids } }] }],
      },
    });
    const activities = await prisma.dailyActivity.findMany({
      where: {
        userId,
        OR: [
          { id: { in: states.map((s) => s.activityId) } },
          { googleEventId: { in: ids }, calendarConnectionId: { in: [connectionId] } },
          { googleEventId: { in: ids }, calendarConnectionId: null },
        ],
      },
      include: { checklistItems: { orderBy: { order: 'asc' } } },
    });
    const stateById = new Map(states.map((s) => [s.activityId, s]));
    const byEvent = new Map(
      activities
        .filter((a) => a.calendarConnectionId === connectionId)
        .map((a) => [a.googleEventId, a]),
    );
    const tombstones = new Set(
      states
        .filter((s) => s.calendarConnectionId === connectionId && s.pendingDelete)
        .map((s) => s.googleEventId),
    );
    const masters = new Set(
      activities
        .filter((a) => a.calendarConnectionId === connectionId && a.recurrence)
        .map((a) => a.googleEventId),
    );
    for (const event of items) {
      let activity = byEvent.get(event.id);
      let rebound = false;
      if (!activity && event.status !== 'cancelled' && event.start) {
        const legacy = activities.find(
          (a) => !a.calendarConnectionId && a.googleEventId === event.id,
        );
        // Exact ID plus application metadata (or matching title/time for old imported events).
        const owner = event.extendedProperties?.private?.purrificActivityId;
        if (
          legacy &&
          (owner
            ? owner === legacy.id
            : event.summary === legacy.title &&
              googleCalendarValues(event).start === activityCalendarValues(legacy).start)
        ) {
          activity = await prisma.dailyActivity.update({
            where: { id: legacy.id },
            data: { calendarConnectionId: connectionId },
            include: { checklistItems: true },
          });
          const state = stateById.get(legacy.id);
          if (state)
            await prisma.calendarSyncState.update({
              where: { id: state.id },
              data: { calendarConnectionId: connectionId },
            });
          byEvent.set(event.id, activity);
          rebound = true;
        }
      }
      const isMasterInstance = Boolean(event.recurringEventId && masters.has(event.recurringEventId));
      if (
        tombstones.has(event.id) ||
        (event.recurringEventId && tombstones.has(event.recurringEventId)) ||
        (isMasterInstance && !activity)
      )
        continue;
      if (activity) {
        const state = stateById.get(activity.id);
        if (!state?.pending && state?.googleEtag && state.googleEtag === event.etag) {
          if (rebound) result.updatedCount++;
          continue;
        }
        const sync = await syncActivityLocked(
          userId,
          activity.id,
          event.status === 'cancelled' ? null : event,
        );
        result.pushedCount += Number(sync.pushed);
        result.updatedCount += Number(sync.updated || rebound);
        result.deletedCount += Number(sync.deleted);
      } else if (event.status !== 'cancelled' && event.start) {
        const date = new Date(event.start.dateTime || event.start.date!);
        // Baseline may span years. Import history only when it is displayed; existing links still update everywhere.
        if (
          (!window || (date >= window.start && date < window.end)) &&
          !states.some(
            (s) => s.calendarConnectionId === connectionId && s.recurringEventId === event.id,
          )
        ) {
          const imported = await importGoogleEventLocked(userId, event, true);
          if (imported) {
            byEvent.set(event.id, imported);
            result.importedCount++;
          }
        }
      }
      // A master delta invalidates linked instances, including ones outside the displayed window.
      for (const state of states.filter(
        (s) =>
          s.calendarConnectionId === connectionId &&
          s.recurringEventId === event.id &&
          !s.pendingDelete,
      )) {
        if (activities.some((a) => a.id === state.activityId))
          instances.push({
            activityId: state.activityId,
            eventId: state.googleEventId!,
            cancelled: event.status === 'cancelled',
          });
      }
    }
  });
  let nextInstance = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, instances.length) }, async () => {
      for (;;) {
        const instance = instances[nextInstance++];
        if (!instance) return;
        let remote: GoogleCalendarEventItem | null = null;
        if (!instance.cancelled) {
          const response = await calendarRequest(
            userId,
            eventPath(instance.eventId),
            {},
            connectionId,
          );
          if (response.status !== 404 && response.status !== 410 && !response.ok)
            throw new CalendarSyncError(502, 'Perubahan jadwal berulang belum dapat dibaca.');
          if (response.ok) remote = (await response.json()) as GoogleCalendarEventItem;
        }
        await withUserCalendarLock(userId, async () => {
          await assertConnection(userId, connectionId);
          const sync = await syncActivityLocked(userId, instance.activityId, remote);
          result.updatedCount += Number(sync.updated);
          result.deletedCount += Number(sync.deleted);
        });
      }
    }),
  );
}

async function drainPending(userId: string, connectionId: string, result: SyncResult) {
  await assertConnection(userId, connectionId);
  const states = await prisma.calendarSyncState.findMany({
    where: { userId, calendarConnectionId: connectionId, pending: true },
  });
  for (const state of states)
    await withUserCalendarLock(userId, async () => {
      await assertConnection(userId, connectionId);
      if (state.pendingDelete)
        result.deletedCount += Number(await flushCalendarDeleteLocked(userId, state.activityId));
      else {
        const sync = await syncActivityLocked(userId, state.activityId);
        result.pushedCount += Number(sync.pushed);
        result.updatedCount += Number(sync.updated);
      }
    });
  const local = await prisma.dailyActivity.findMany({
    where: {
      userId,
      calendarConnectionId: null,
      googleEventId: null,
      OR: [{ startTime: { not: null } }, { allDay: true }],
    },
  });
  for (const activity of local)
    await withUserCalendarLock(userId, async () => {
      await assertConnection(userId, connectionId);
      const sync = await syncActivityLocked(userId, activity.id);
      result.pushedCount += Number(sync.pushed);
    });
}

async function fetchCanonical(
  userId: string,
  connectionId: string,
  syncToken: string | null,
  result: SyncResult,
  window: { start: Date; end: Date },
) {
  let pageToken: string | undefined;
  let nextSyncToken: string | undefined;
  const seen = new Set<string>();
  // Capture links before the baseline starts; newly saved cards are handled by the next delta.
  const baselineLinks = !syncToken
    ? await prisma.calendarSyncState.findMany({
        where: {
          userId,
          calendarConnectionId: connectionId,
          pendingDelete: false,
          googleEventId: { not: null },
          googleEtag: { not: null },
        },
      })
    : [];
  do {
    const params = new URLSearchParams({
      singleEvents: 'false',
      showDeleted: 'true',
      maxResults: '2500',
    });
    if (syncToken) params.set('syncToken', syncToken);
    if (pageToken) params.set('pageToken', pageToken);
    // Remote waits happen outside the mutation lock, so dragging and switching remain responsive.
    const response = await calendarRequest(userId, `?${params}`, {}, connectionId);
    if (response.status === 410 && syncToken) {
      await withUserCalendarLock(userId, async () => {
        await assertConnection(userId, connectionId);
        await prisma.googleCalendarConnection.update({
          where: { id: connectionId },
          data: { syncToken: null },
        });
      });
      await fetchCanonical(userId, connectionId, null, result, window);
      return;
    }
    if (!response.ok)
      throw new CalendarSyncError(502, 'Perubahan Google Calendar belum dapat dibaca.');
    const page = (await response.json()) as {
      items?: GoogleCalendarEventItem[];
      nextPageToken?: string;
      nextSyncToken?: string;
    };
    for (const event of page.items || []) seen.add(event.id);
    await applyEventPage(userId, connectionId, page.items || [], result, window);
    pageToken = page.nextPageToken;
    nextSyncToken = page.nextSyncToken;
  } while (pageToken);
  if (!nextSyncToken)
    throw new CalendarSyncError(502, 'Google belum mengembalikan token sinkronisasi.');
  for (const state of baselineLinks) {
    if (
      seen.has(state.googleEventId!) ||
      (state.recurringEventId && seen.has(state.recurringEventId))
    )
      continue;
    const response = await calendarRequest(
      userId,
      eventPath(state.googleEventId!),
      {},
      connectionId,
    );
    if (response.status !== 404 && response.status !== 410 && !response.ok)
      throw new CalendarSyncError(502, 'Validasi ulang jadwal Google tertunda.');
    const event = response.ok
      ? ((await response.json()) as GoogleCalendarEventItem)
      : { id: state.googleEventId!, status: 'cancelled' };
    await applyEventPage(userId, connectionId, [event], result, window);
  }
  await withUserCalendarLock(userId, async () => {
    await assertConnection(userId, connectionId);
    await prisma.googleCalendarConnection.update({
      where: { id: connectionId },
      data: { syncToken: nextSyncToken },
    });
  });
}

async function hydrateVisibleRange(
  userId: string,
  connectionId: string,
  window: { start: Date; end: Date },
  result: SyncResult,
) {
  const params = new URLSearchParams({
    timeMin: window.start.toISOString(),
    timeMax: window.end.toISOString(),
    singleEvents: 'true',
    showDeleted: 'true',
    orderBy: 'startTime',
    maxResults: '2500',
  });
  let pageToken: string | undefined;
  do {
    if (pageToken) params.set('pageToken', pageToken);
    const response = await calendarRequest(userId, `?${params}`, {}, connectionId);
    if (!response.ok)
      throw new CalendarSyncError(502, 'Rentang Google Calendar belum dapat dibaca.');
    const page = (await response.json()) as {
      items?: GoogleCalendarEventItem[];
      nextPageToken?: string;
    };
    // Google filters by overlap, so an event may begin before the displayed range.
    await applyEventPage(userId, connectionId, page.items || [], result);
    pageToken = page.nextPageToken;
  } while (pageToken);
}

async function finishSync(userId: string, result: SyncResult) {
  await withUserCalendarLock(userId, async () => {
    await assertConnection(userId, result.connectionId);
    result.pendingCount = await prisma.calendarSyncState.count({
      where: { userId, calendarConnectionId: result.connectionId, pending: true },
    });
    if (!result.pendingCount && !result.baselinePending) {
      result.syncedAt = new Date().toISOString();
      await prisma.googleCalendarConnection.update({
        where: { id: result.connectionId },
        data: { syncedAt: new Date(result.syncedAt) },
      });
      await prisma.user.updateMany({
        where: { id: userId, googleCalendarConnectionId: result.connectionId },
        data: { googleCalendarSyncedAt: new Date(result.syncedAt) },
      });
    }
    if (result.importedCount || result.updatedCount || result.deletedCount || result.pushedCount)
      emitToUser(userId, 'calendar:synced', { action: 'autoSync', ...result });
    else if (result.syncedAt)
      emitToUser(userId, 'calendar:synced', {
        action: 'baseline',
        connectionId: result.connectionId,
        pendingCount: result.pendingCount,
        syncedAt: result.syncedAt,
      });
  });
}

export async function autoSyncTwoWay(
  userId: string,
  from?: string,
  to?: string,
  expected?: string | null,
  options: { hydrateRange?: boolean } = {},
): Promise<SyncResult> {
  const token = await getValidUserToken(userId, expected);
  if ('error' in token) throw new CalendarSyncError(token.code, token.error);
  const connectionId = token.connectionId;
  const today = calendarDate(new Date());
  const year = Number(today.slice(0, 4)),
    month = Number(today.slice(5, 7)) - 1;
  const window = {
    start: from ? new Date(from) : new Date(Date.UTC(year, month, -6)),
    end: to ? new Date(to) : new Date(Date.UTC(year, month + 1, 8)),
  };
  if (
    !Number.isFinite(window.start.getTime()) ||
    !Number.isFinite(window.end.getTime()) ||
    window.start >= window.end
  )
    throw new CalendarSyncError(422, 'Rentang kalender tidak valid.');
  const rangeKey = `${window.start.toISOString()}/${window.end.toISOString()}`;
  const hydrateRange = options.hydrateRange ?? false;
  const current = syncFlights.get(connectionId);
  if (current?.rangeKey === rangeKey && (!hydrateRange || current.hydrateRange))
    return current.promise;
  const run = (async () => {
    // Preserve requests for other ranges; an overlapping caller must not receive
    // success for dates that were never imported. A failed predecessor does not
    // prevent the next range from being attempted.
    if (current) await current.promise.catch(() => undefined);
    await assertConnection(userId, connectionId);
    const result = emptyResult(connectionId);
    await drainPending(userId, connectionId, result);
    const connection = await prisma.googleCalendarConnection.findUniqueOrThrow({
      where: { id: connectionId },
    });
    if (hydrateRange || !connection.syncToken)
      await hydrateVisibleRange(userId, connectionId, window, result);
    if (connection.syncToken)
      await fetchCanonical(userId, connectionId, connection.syncToken, result, window);
    else {
      // Fetch the visible dates first, then build the unbounded canonical cursor in the background.
      result.baselinePending = true;
      if (!baselines.has(connectionId)) {
        const background = (async () => {
          const baseline = emptyResult(connectionId);
          try {
            await fetchCanonical(userId, connectionId, null, baseline, window);
            await finishSync(userId, baseline);
          } catch (error) {
            if (!(error instanceof CalendarSyncError && error.code === 409))
              emitToUser(userId, 'calendar:synced', {
                connectionId,
                action: 'baseline',
                retry: true,
              });
          }
        })();
        baselines.set(connectionId, background);
        void background.finally(() => {
          if (baselines.get(connectionId) === background) baselines.delete(connectionId);
        });
      }
    }
    await finishSync(userId, result);
    return result;
  })();
  const flight = { rangeKey, hydrateRange, promise: run };
  syncFlights.set(connectionId, flight);
  try {
    return await run;
  } finally {
    if (syncFlights.get(connectionId) === flight) syncFlights.delete(connectionId);
  }
}

// Useful for graceful shutdown and integration tests; browser requests never wait for this baseline.
export async function waitForCalendarBaseline(connectionId: string) {
  await baselines.get(connectionId);
}
