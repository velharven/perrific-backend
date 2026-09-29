CREATE TABLE "google_calendar_connections" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "googleSubject" TEXT NOT NULL,
  "calendarId" TEXT NOT NULL DEFAULT 'primary',
  "email" TEXT,
  "syncToken" TEXT,
  "syncedAt" TIMESTAMP(3)
);
CREATE UNIQUE INDEX "google_calendar_connections_userId_googleSubject_calendarId_key" ON "google_calendar_connections"("userId", "googleSubject", "calendarId");
ALTER TABLE "users" ADD COLUMN "googleCalendarConnectionId" TEXT;
-- Legacy ownership is unknown. Keep it until an authoritative Google event validates it.
ALTER TABLE "daily_activities" ADD COLUMN "calendarConnectionId" TEXT REFERENCES "google_calendar_connections"("id") ON DELETE RESTRICT;
ALTER TABLE "calendar_sync_states" ADD COLUMN "calendarConnectionId" TEXT REFERENCES "google_calendar_connections"("id") ON DELETE RESTRICT;
ALTER TABLE "calendar_sync_states" ADD COLUMN "recurringEventId" TEXT;
CREATE INDEX "daily_activities_userId_calendarConnectionId_googleEventId_idx" ON "daily_activities"("userId", "calendarConnectionId", "googleEventId");
CREATE INDEX "calendar_sync_states_calendarConnectionId_googleEventId_idx" ON "calendar_sync_states"("calendarConnectionId", "googleEventId");
