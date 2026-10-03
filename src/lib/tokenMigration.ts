import { PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from './prisma';
import { encryptToken, isEncryptedToken } from './crypto';

export async function migrateTokensToEncrypted(client: PrismaClient = defaultPrisma) {
  console.log('[Migration] Memulai migrasi token Google Calendar ke format terenkripsi (v1:AES-256-GCM)...');

  const users = await client.user.findMany({
    where: {
      OR: [
        { googleCalendarAccessToken: { not: null } },
        { googleCalendarRefreshToken: { not: null } },
      ],
    },
    select: {
      id: true,
      email: true,
      googleCalendarAccessToken: true,
      googleCalendarRefreshToken: true,
    },
  });

  console.log(`[Migration] Menemukan ${users.length} pengguna dengan token Google Calendar.`);

  let migratedCount = 0;
  let skippedCount = 0;

  for (const user of users) {
    const rawAccess = user.googleCalendarAccessToken;
    const rawRefresh = user.googleCalendarRefreshToken;

    const accessNeedsEncrypt = Boolean(rawAccess && !isEncryptedToken(rawAccess));
    const refreshNeedsEncrypt = Boolean(rawRefresh && !isEncryptedToken(rawRefresh));

    if (!accessNeedsEncrypt && !refreshNeedsEncrypt) {
      skippedCount++;
      continue;
    }

    const updatedData: {
      googleCalendarAccessToken?: string;
      googleCalendarRefreshToken?: string;
    } = {};

    if (accessNeedsEncrypt && rawAccess) {
      updatedData.googleCalendarAccessToken = encryptToken(rawAccess);
    }

    if (refreshNeedsEncrypt && rawRefresh) {
      updatedData.googleCalendarRefreshToken = encryptToken(rawRefresh);
    }

    await client.user.update({
      where: { id: user.id },
      data: updatedData,
    });

    migratedCount++;
    console.log(`[Migration] Berhasil mengenkripsi token untuk pengguna: ${user.email} (${user.id})`);
  }

  console.log(
    `[Migration] Selesai. Total pengguna dimigrasi: ${migratedCount}, sudah terenkripsi/dilewati: ${skippedCount}.`,
  );
  return { migratedCount, skippedCount, totalScanned: users.length };
}
