-- Kode invite tim bisa kedaluwarsa (null = tanpa batas; data lama otomatis tanpa batas)
ALTER TABLE "teams" ADD COLUMN "inviteExpiresAt" TIMESTAMP(3);
