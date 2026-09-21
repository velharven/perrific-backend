import cron from 'node-cron';
import { pruneOldNotifications, NOTIFICATION_RETENTION_DAYS } from './cleanup';

/**
 * Scheduler in-process (tanpa infra tambahan seperti Redis).
 * Cukup untuk 1 instance; jika nanti scale multi-instance,
 * pindahkan ke job queue (mis. BullMQ + Redis).
 */
export function startScheduler() {
  // Jalan sekali saat boot agar langsung efektif di dev/demo.
  pruneOldNotifications()
    .then((count) => {
      if (count > 0) console.log(`[scheduler] prune notifikasi: ${count} baris dihapus`);
    })
    .catch((err) => console.error('[scheduler] prune notifikasi gagal:', err));

  // Tiap hari jam 03:00 waktu server.
  cron.schedule('0 3 * * *', () => {
    pruneOldNotifications()
      .then((count) => console.log(`[scheduler] prune notifikasi harian: ${count} baris dihapus`))
      .catch((err) => console.error('[scheduler] prune notifikasi gagal:', err));
  });

  console.log(
    `[scheduler] aktif (retensi notifikasi ${NOTIFICATION_RETENTION_DAYS} hari, harian 03:00)`,
  );
}
