-- Adds the videoUrl column required by the local-video upload feature.
-- Run this once against your Supabase `projects` table if it was created
-- before video support was added. Without this column, GET /api/projects,
-- POST /api/projects and PUT /api/projects/:id return HTTP 500.
alter table projects add column if not exists "videoUrl" text;
