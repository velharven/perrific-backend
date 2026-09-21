-- Warna swatch per kolom kanban (editable admin)
ALTER TABLE "board_columns" ADD COLUMN "color" TEXT NOT NULL DEFAULT '#8A8F98';
