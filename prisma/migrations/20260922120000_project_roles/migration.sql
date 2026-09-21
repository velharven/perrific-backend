-- Role custom per project + jabatan anggota per project
CREATE TABLE "project_roles" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "system" TEXT,
  "permissions" TEXT[] NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "project_roles_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "project_roles_projectId_name_key" ON "project_roles"("projectId", "name");

ALTER TABLE "project_roles" ADD CONSTRAINT "project_roles_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "project_members" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "roleId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "project_members_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "project_members_projectId_userId_key" ON "project_members"("projectId", "userId");
CREATE INDEX "project_members_projectId_idx" ON "project_members"("projectId");

ALTER TABLE "project_members" ADD CONSTRAINT "project_members_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "project_roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Backfill: 6 role bawaan per project lama
INSERT INTO "project_roles" ("id", "projectId", "name", "system", "permissions", "createdAt")
SELECT gen_random_uuid(), p."id", v."name", v."system", v."permissions", CURRENT_TIMESTAMP
FROM "projects" p CROSS JOIN (VALUES
  ('Admin', 'ADMIN', '{task.create,task.move,task.delete,task.approve,member.approve,column.manage,invite.manage,project.manage,role.manage}'::text[]),
  ('Approver', 'APPROVER', '{task.create,task.move,task.approve,member.approve}'::text[]),
  ('Member', 'MEMBER', '{task.create,task.move}'::text[]),
  ('Front', NULL, '{task.create,task.move}'::text[]),
  ('Back', NULL, '{task.create,task.move}'::text[]),
  ('Design', NULL, '{task.create,task.move}'::text[])
) AS v("name", "system", "permissions");

-- Backfill: seluruh anggota tim menjadi Member di tiap project timnya
INSERT INTO "project_members" ("id", "projectId", "userId", "roleId", "createdAt")
SELECT gen_random_uuid(), p."id", tm."userId", r."id", CURRENT_TIMESTAMP
FROM "projects" p
JOIN "team_members" tm ON tm."teamId" = p."teamId"
JOIN "project_roles" r ON r."projectId" = p."id" AND r."system" = 'MEMBER';
