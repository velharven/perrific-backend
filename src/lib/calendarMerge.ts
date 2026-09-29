export interface CalendarValues {
  title: string;
  description: string;
  start: string;
  end: string;
  color: string | null;
  recurrence: string[] | null;
  checklist: string;
}

export const CALENDAR_FIELDS = [
  'title',
  'description',
  'start',
  'end',
  'color',
  'recurrence',
  'checklist',
] as const;
export type CalendarField = (typeof CALENDAR_FIELDS)[number];
export type CalendarChanges = Partial<Record<CalendarField, string>>;
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  }
  return value;
}
export const sameCalendarValue = (a: unknown, b: unknown) =>
  JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

export function mergeCalendarValues(
  baseline: CalendarValues,
  local: CalendarValues,
  remote: CalendarValues,
  changedAt: CalendarChanges,
  remoteUpdatedAt: string | undefined,
): CalendarValues {
  const merged = { ...remote };
  for (const field of CALENDAR_FIELDS) {
    const localChanged = !sameCalendarValue(local[field], baseline[field]);
    const remoteChanged = !sameCalendarValue(remote[field], baseline[field]);
    const localTime = changedAt[field] ? new Date(changedAt[field]!).getTime() : 0;
    const remoteTime = remoteUpdatedAt ? new Date(remoteUpdatedAt).getTime() : 0;
    const chooseLocal =
      field === 'checklist' || (localChanged && (!remoteChanged || localTime >= remoteTime));
    if (chooseLocal) Object.assign(merged, { [field]: local[field] });
  }
  return merged;
}

export function calendarDate(value: string | Date): string {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const date = typeof value === 'string' ? new Date(value) : value;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const part = (type: string) => parts.find((entry) => entry.type === type)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

export function nextCalendarDate(date: string): string {
  const next = new Date(`${date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}
