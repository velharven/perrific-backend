import type { User } from '@prisma/client';

export type AssigneeOut = Pick<User, 'id' | 'name' | 'avatarUrl'>;

// Include junction + flatten ke array user agar respons tetap datar.
export const assigneesInclude = {
  assignees: { include: { user: { select: { id: true, name: true, avatarUrl: true } } } },
};

export const watchersInclude = {
  watchers: { include: { user: { select: { id: true, name: true, avatarUrl: true } } } },
};

export const createdBySelect = {
  createdBy: { select: { id: true, name: true, avatarUrl: true } },
};

export const columnSelect = {
  column: { select: { id: true, name: true, order: true } },
};

export function withAssignees<T extends { assignees: { user: AssigneeOut }[] }>(
  row: T,
): Omit<T, 'assignees'> & { assignees: AssigneeOut[] } {
  const { assignees, ...rest } = row;
  return { ...rest, assignees: assignees.map((a) => a.user) };
}

export function withWatchers<T extends { watchers: { user: AssigneeOut }[] }>(
  row: T,
): Omit<T, 'watchers'> & { watchers: AssigneeOut[] } {
  const { watchers, ...rest } = row;
  return { ...rest, watchers: watchers.map((w) => w.user) };
}

// Samakan + hilangkan duplikat id sebelum tulis junction.
export function uniqIds(ids: string[] | undefined): string[] {
  return [...new Set((ids ?? []).filter((id) => id.trim() !== ''))];
}
