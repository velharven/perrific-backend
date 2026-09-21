-- Kolom kanban bebas per project ala Taiga (pengganti enum TaskStatus kaku)
CREATE TABLE "board_columns" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "order" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "board_columns_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "board_columns_projectId_order_idx" ON "board_columns"("projectId", "order");

ALTER TABLE "board_columns" ADD CONSTRAINT "board_columns_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 3 kolom bawaan per project lama (urutan sama seperti board lama)
INSERT INTO "board_columns" ("id", "projectId", "name", "order", "createdAt")
SELECT gen_random_uuid(), "id", 'To Do', 0, CURRENT_TIMESTAMP FROM "projects"
UNION ALL
SELECT gen_random_uuid(), "id", 'In Progress', 1, CURRENT_TIMESTAMP FROM "projects"
UNION ALL
SELECT gen_random_uuid(), "id", 'Done', 2, CURRENT_TIMESTAMP FROM "projects";

-- Task menunjuk kolomnya
ALTER TABLE "tasks" ADD COLUMN "columnId" TEXT;

UPDATE "tasks" t SET "columnId" = (
  SELECT c."id" FROM "board_columns" c
  WHERE c."projectId" = t."projectId" AND (
    (t."status" = 'TODO' AND c."name" = 'To Do') OR
    (t."status" = 'IN_PROGRESS' AND c."name" = 'In Progress') OR
    (t."status" = 'DONE' AND c."name" = 'Done')
  )
);

ALTER TABLE "tasks" ALTER COLUMN "columnId" SET NOT NULL;
ALTER TABLE "tasks" DROP COLUMN "status";

ALTER TABLE "tasks" ADD CONSTRAINT "tasks_columnId_fkey" FOREIGN KEY ("columnId") REFERENCES "board_columns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "tasks_columnId_idx" ON "tasks"("columnId");

-- Riwayat pindah card menyimpan nama kolom (teks bebas) bukan enum
ALTER TABLE "task_activities" ALTER COLUMN "fromStatus" TYPE TEXT USING (
  CASE "fromStatus"::text
    WHEN 'TODO' THEN 'To Do'
    WHEN 'IN_PROGRESS' THEN 'In Progress'
    WHEN 'DONE' THEN 'Done'
    ELSE NULL
  END
);
ALTER TABLE "task_activities" ALTER COLUMN "toStatus" TYPE TEXT USING (
  CASE "toStatus"::text
    WHEN 'TODO' THEN 'To Do'
    WHEN 'IN_PROGRESS' THEN 'In Progress'
    WHEN 'DONE' THEN 'Done'
    ELSE NULL
  END
);
ALTER TABLE "task_activities" RENAME COLUMN "fromStatus" TO "fromColumn";
ALTER TABLE "task_activities" RENAME COLUMN "toStatus" TO "toColumn";

DROP TYPE "TaskStatus";
