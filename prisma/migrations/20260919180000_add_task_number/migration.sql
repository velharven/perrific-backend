-- Nomor urut task per project (backfill dari createdAt agar data lama konsisten)
ALTER TABLE "tasks" ADD COLUMN "number" INTEGER;

WITH ranked AS (
  SELECT "id", ROW_NUMBER() OVER (PARTITION BY "projectId" ORDER BY "createdAt" ASC, "id" ASC) AS rn
  FROM "tasks"
)
UPDATE "tasks" t SET "number" = r.rn FROM ranked r WHERE t."id" = r."id";

ALTER TABLE "tasks" ALTER COLUMN "number" SET NOT NULL;

CREATE UNIQUE INDEX "tasks_projectId_number_key" ON "tasks"("projectId", "number");
