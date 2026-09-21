-- Assignee jamak per task via junction (menggantikan tasks.assigneeId tunggal)
CREATE TABLE "task_assignees" (
  "id" TEXT NOT NULL,
  "taskId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "task_assignees_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "task_assignees_taskId_userId_key" ON "task_assignees"("taskId", "userId");
CREATE INDEX "task_assignees_taskId_idx" ON "task_assignees"("taskId");
CREATE INDEX "task_assignees_userId_idx" ON "task_assignees"("userId");

ALTER TABLE "task_assignees" ADD CONSTRAINT "task_assignees_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "task_assignees" ADD CONSTRAINT "task_assignees_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: assignee tunggal lama menjadi 1 baris junction
INSERT INTO "task_assignees" ("id", "taskId", "userId", "createdAt")
SELECT gen_random_uuid(), "id", "assigneeId", CURRENT_TIMESTAMP FROM "tasks" WHERE "assigneeId" IS NOT NULL;

ALTER TABLE "tasks" DROP CONSTRAINT "tasks_assigneeId_fkey";
DROP INDEX "tasks_assigneeId_idx";
ALTER TABLE "tasks" DROP COLUMN "assigneeId";
