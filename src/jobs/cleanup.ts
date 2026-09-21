import { prisma } from '../lib/prisma';

// Berapa lama notifikasi disimpan sebelum dibersihkan otomatis.
export const NOTIFICATION_RETENTION_DAYS = 30;

/**
 * Hapus notifikasi yang lebih tua dari masa retensi.
 * Dijalankan berkala oleh scheduler agar tabel tidak tumbuh tanpa batas.
 * Mengembalikan jumlah baris yang dihapus.
 */
export async function pruneOldNotifications(): Promise<number> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - NOTIFICATION_RETENTION_DAYS);
  const result = await prisma.notification.deleteMany({
    where: { createdAt: { lt: cutoff } },
  });
  return result.count;
}
