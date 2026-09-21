-- Caption pendek per lampiran (nullable agar data lama aman)
ALTER TABLE "attachments" ADD COLUMN "description" TEXT;
