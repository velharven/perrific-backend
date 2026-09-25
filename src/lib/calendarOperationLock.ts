// Serialisasi operasi kalender per pengguna pada proses server ini. Sinkronisasi
// yang sedang mengimpor event tidak boleh membuat ulang kartu saat delete berjalan.
const tails = new Map<string, Promise<void>>();

export async function withUserCalendarLock<T>(userId: string, operation: () => Promise<T>): Promise<T> {
  const previous = tails.get(userId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  tails.set(userId, current);

  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (tails.get(userId) === current) tails.delete(userId);
  }
}
