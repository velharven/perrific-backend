-- Pelacak pembuat task untuk filter "dibuat oleh" (nullable agar data lama aman)
ALTER TABLE "tasks" ADD COLUMN "createdById" TEXT;

ALTER TABLE "tasks" ADD CONSTRAINT "tasks_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
