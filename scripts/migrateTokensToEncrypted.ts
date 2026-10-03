import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { migrateTokensToEncrypted } from '../src/lib/tokenMigration';

const prisma = new PrismaClient();

export { migrateTokensToEncrypted };

if (require.main === module || (process.argv[1] && process.argv[1].endsWith('migrateTokensToEncrypted.ts'))) {
  migrateTokensToEncrypted(prisma)
    .catch((error) => {
      console.error('[Migration] Terjadi kesalahan saat migrasi token:', error);
      process.exit(1);
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
