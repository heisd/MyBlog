-- Visitor accounts for the project access gate (register with email + code, set
-- password, then log in). `member_until` powers the monthly subscription:
-- a visitor is a member while member_until is in the future (NULL = not a member).
-- Members can see projects' private GitHub repo links and use the AI assistant.
create table if not exists visitors (
  email text primary key,
  password_hash text not null,
  member_until timestamptz,
  created_at timestamptz default now()
);

-- If the table already existed without member_until, add it:
alter table visitors add column if not exists member_until timestamptz;
