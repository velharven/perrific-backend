ALTER TABLE "daily_activities" ADD COLUMN "allDay" BOOLEAN NOT NULL DEFAULT false;
UPDATE "daily_activities" SET "allDay" = true WHERE "googleEventId" IS NOT NULL AND "startTime" IS NULL;

CREATE TABLE "calendar_sync_states" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "activityId" TEXT NOT NULL,
  "googleEventId" TEXT,
  "snapshot" JSONB,
  "localChanges" JSONB,
  "googleEtag" TEXT,
  "pending" BOOLEAN NOT NULL DEFAULT false,
  "pendingDelete" BOOLEAN NOT NULL DEFAULT false,
  "lastError" TEXT,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "calendar_sync_states_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "calendar_sync_states_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "calendar_sync_states_userId_activityId_key" ON "calendar_sync_states"("userId", "activityId");
CREATE INDEX "calendar_sync_states_userId_googleEventId_idx" ON "calendar_sync_states"("userId", "googleEventId");
