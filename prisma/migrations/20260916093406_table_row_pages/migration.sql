-- Baris tabel bisa menaut ke halaman (baris = halaman)
ALTER TABLE "table_rows" ADD COLUMN "noteId" TEXT;

CREATE UNIQUE INDEX "table_rows_noteId_key" ON "table_rows"("noteId");

ALTER TABLE "table_rows" ADD CONSTRAINT "table_rows_noteId_fkey" FOREIGN KEY ("noteId") REFERENCES "notes"("id") ON DELETE SET NULL ON UPDATE CASCADE;
