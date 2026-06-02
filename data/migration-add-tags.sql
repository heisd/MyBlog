-- Adds the tags column for the project category/tag feature.
-- Run this once against your Supabase `projects` table to enable tags.
-- The backend is resilient: until this runs, projects still work but
-- tags are ignored (the list falls back to keyword auto-categorization).
alter table projects add column if not exists tags text[] default '{}';
