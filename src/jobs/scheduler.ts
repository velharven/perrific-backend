import cron from 'node-cron';
import { prisma } from '../lib/prisma';
import { pruneOldNotifications, NOTIFICATION_RETENTION_DAYS } from './cleanup';
import { autoSyncTwoWay } from '../controllers/googleCalendarController';

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

  // Sinkronisasi otomatis dua arah Google Calendar untuk 1 hari setiap tengah malam (jam 00:00)
  cron.schedule('0 0 * * *', async () => {
    try {
      const connectedUsers = await prisma.user.findMany({
        where: { googleCalendarConnected: true },
        select: { id: true },
      });

      for (const u of connectedUsers) {
        try {
          await autoSyncTwoWay(u.id);
        } catch (syncErr) {
          console.error(`[scheduler] sync google calendar user ${u.id} error:`, syncErr);
        }
      }
    } catch (err) {
      console.error('[scheduler] auto-sync google calendar cron error:', err);
    }
  });

  console.log(
    `[scheduler] aktif (retensi notifikasi ${NOTIFICATION_RETENTION_DAYS} hari, harian 03:00, auto-sync gcal harian 00:00)`,
  );
}

