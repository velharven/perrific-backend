-- CreateEnum
CREATE TYPE "NoteKind" AS ENUM ('NOTE', 'DASHBOARD', 'DAILY');

-- AlterTable
ALTER TABLE "notes" ADD COLUMN     "kind" "NoteKind" NOT NULL DEFAULT 'NOTE';
