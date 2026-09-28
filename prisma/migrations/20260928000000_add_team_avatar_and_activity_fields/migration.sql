-- AlterTable
ALTER TABLE "teams" ADD COLUMN "avatarUrl" TEXT;

-- AlterTable
ALTER TABLE "daily_activities" ADD COLUMN "recurrence" JSONB,
ADD COLUMN "color" TEXT;
