-- Properti kustom database harian personal (ala kolom Notion)
CREATE TYPE "DailyColumnType" AS ENUM ('TEXT', 'NUMBER', 'DATE', 'SELECT', 'CHECKBOX');

CREATE TABLE "daily_columns" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "type" "DailyColumnType" NOT NULL DEFAULT 'TEXT',
  "icon" TEXT,
  "options" JSONB,
  "order" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "daily_columns_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "daily_columns_userId_idx" ON "daily_columns"("userId");

ALTER TABLE "daily_columns" ADD CONSTRAINT "daily_columns_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Nilai properti kustom per aktivitas (peta columnId -> nilai)
ALTER TABLE "daily_activities" ADD COLUMN "customValues" JSONB;
