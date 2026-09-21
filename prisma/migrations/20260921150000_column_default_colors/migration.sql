-- Warna bawaan beda per kolom standar (kolom custom tetap abu)
UPDATE "board_columns" SET "color" = '#0090FF' WHERE "name" = 'In Progress' AND "color" = '#8A8F98';
UPDATE "board_columns" SET "color" = '#46A758' WHERE "name" = 'Done' AND "color" = '#8A8F98';
