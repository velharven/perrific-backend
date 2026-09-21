-- Persetujuan task: anggota boleh mengusul, admin menyetujui (default APPROVED agar data lama aman)
CREATE TYPE "ApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

ALTER TABLE "tasks" ADD COLUMN "approval" "ApprovalStatus" NOT NULL DEFAULT 'APPROVED';
