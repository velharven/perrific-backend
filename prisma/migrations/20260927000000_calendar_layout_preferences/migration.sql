CREATE TABLE "calendar_layout_preferences" (
    "userId" TEXT NOT NULL,
    "date" VARCHAR(10) NOT NULL,
    "eventKey" VARCHAR(512) NOT NULL,
    "position" INTEGER NOT NULL,
    CONSTRAINT "calendar_layout_preferences_pkey" PRIMARY KEY ("userId", "date", "eventKey")
);

CREATE INDEX "calendar_layout_preferences_userId_date_idx"
ON "calendar_layout_preferences"("userId", "date");

ALTER TABLE "calendar_layout_preferences"
ADD CONSTRAINT "calendar_layout_preferences_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
