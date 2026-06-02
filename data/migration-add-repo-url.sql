-- Adds the repoUrl column for linking each project to its GitHub repository.
-- Run this once against your Supabase `projects` table. The backend is
-- resilient: until this runs, projects still work but repoUrl is ignored.
alter table projects add column if not exists "repoUrl" text;
