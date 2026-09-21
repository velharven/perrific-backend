ALTER TYPE "NoteKind" ADD VALUE 'TABLE';

ALTER TABLE "notes" ADD COLUMN "parentId" TEXT;
ALTER TABLE "notes" ADD CONSTRAINT "notes_parentId_fkey"
  FOREIGN KEY ("parentId") REFERENCES "notes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "notes_userId_parentId_order_idx" ON "notes"("userId", "parentId", "order");

CREATE TYPE "TableColumnType" AS ENUM ('TEXT', 'NUMBER', 'SELECT', 'DATE', 'CHECKBOX');

CREATE TABLE "tables" (
  "id" TEXT NOT NULL,
  "noteId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "tables_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "tables_noteId_key" ON "tables"("noteId");
ALTER TABLE "tables" ADD CONSTRAINT "tables_noteId_fkey"
  FOREIGN KEY ("noteId") REFERENCES "notes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "table_columns" (
  "id" TEXT NOT NULL,
  "tableId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "type" "TableColumnType" NOT NULL DEFAULT 'TEXT',
  "options" JSONB NOT NULL DEFAULT '[]',
  "order" DOUBLE PRECISION NOT NULL DEFAULT 0,
  CONSTRAINT "table_columns_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "table_columns_tableId_order_idx" ON "table_columns"("tableId", "order");
ALTER TABLE "table_columns" ADD CONSTRAINT "table_columns_tableId_fkey"
  FOREIGN KEY ("tableId") REFERENCES "tables"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "table_rows" (
  "id" TEXT NOT NULL,
  "tableId" TEXT NOT NULL,
  "values" JSONB NOT NULL DEFAULT '{}',
  "order" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "table_rows_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "table_rows_tableId_order_idx" ON "table_rows"("tableId", "order");
ALTER TABLE "table_rows" ADD CONSTRAINT "table_rows_tableId_fkey"
  FOREIGN KEY ("tableId") REFERENCES "tables"("id") ON DELETE CASCADE ON UPDATE CASCADE;
