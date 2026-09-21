-- Kind baru ATTACHMENT_ADDED + kolom meta (cara aman dalam transaksi:
-- buat type baru, pindahkan kolom, tukar nama, hapus yang lama)
CREATE TYPE "TaskActivityKind_new" AS ENUM ('MOVED', 'ASSIGNED', 'UNASSIGNED', 'ATTACHMENT_ADDED');

ALTER TABLE "task_activities" ALTER COLUMN "kind" TYPE "TaskActivityKind_new" USING "kind"::text::"TaskActivityKind_new";

ALTER TYPE "TaskActivityKind" RENAME TO "TaskActivityKind_old";

ALTER TYPE "TaskActivityKind_new" RENAME TO "TaskActivityKind";

DROP TYPE "TaskActivityKind_old";

ALTER TABLE "task_activities" ADD COLUMN "meta" JSONB;
