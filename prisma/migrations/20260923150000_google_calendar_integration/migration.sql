-- AlterTable
ALTER TABLE "users" ADD COLUMN "googleCalendarConnected" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "googleCalendarEmail" TEXT,
ADD COLUMN "googleCalendarAccessToken" TEXT,
ADD COLUMN "googleCalendarSyncedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "daily_activities" ADD COLUMN "googleEventId" TEXT;
