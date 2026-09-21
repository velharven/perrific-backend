-- AlterTable
ALTER TABLE "daily_activities" ADD COLUMN     "icon" TEXT,
ADD COLUMN     "order" DOUBLE PRECISION NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "checklist_items" (
    "id" TEXT NOT NULL,
    "activityId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "completed" BOOLEAN NOT NULL DEFAULT false,
    "order" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "checklist_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "checklist_items_activityId_idx" ON "checklist_items"("activityId");

-- AddForeignKey
ALTER TABLE "checklist_items" ADD CONSTRAINT "checklist_items_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES "daily_activities"("id") ON DELETE CASCADE ON UPDATE CASCADE;
