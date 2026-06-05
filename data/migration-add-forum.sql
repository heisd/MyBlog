-- Forum feature: account holders can publish articles/threads and discuss.
-- Each visitor gets a unique `username` that is their public identity on the site.
--
-- Access to these tables always goes through the Node backend using the Supabase
-- service-role key (which bypasses RLS), so no RLS policies are needed here.

-- 1) Give every visitor a public username (unique, case-insensitive).
--    NULL is allowed so existing/placeholder accounts can claim a name later.
alter table visitors add column if not exists username text;
create unique index if not exists visitors_username_lower_idx
  on visitors (lower(username));

-- 2) Forum posts (articles / discussion threads).
--    author_email may be NULL (e.g. admin posts, or after a visitor is removed);
--    author_username is denormalized so posts keep their attribution.
create table if not exists forum_posts (
  id uuid primary key default gen_random_uuid(),
  author_email text references visitors(email) on delete set null,
  author_username text not null,
  title text not null,
  content text not null,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists forum_posts_created_at_idx
  on forum_posts (created_at desc);

-- 3) Forum replies (the discussion under each post).
create table if not exists forum_replies (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references forum_posts(id) on delete cascade,
  author_email text references visitors(email) on delete set null,
  author_username text not null,
  content text not null,
  created_at timestamptz default now()
);

create index if not exists forum_replies_post_id_idx
  on forum_replies (post_id, created_at);
