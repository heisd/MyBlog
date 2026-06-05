-- Follow relationships: a visitor (follower_email) follows a public user
-- (following_username). One row per relationship.
create table if not exists forum_follows (
  follower_email text not null references visitors(email) on delete cascade,
  following_username text not null,
  created_at timestamptz default now(),
  primary key (follower_email, following_username)
);

create index if not exists forum_follows_following_idx on forum_follows (following_username);
create index if not exists forum_follows_follower_idx on forum_follows (follower_email);
