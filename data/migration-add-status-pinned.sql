-- Adds draft/published status and a pinned (top) flag for projects.
-- Run this once against your Supabase `projects` table to enable the
-- draft and pin-to-top features. The backend is resilient: until this
-- runs, projects still work but status/pinned are ignored.
alter table projects add column if not exists status text default 'published';
alter table projects add column if not exists pinned boolean default false;
