-- Visitor accounts for the project access gate (register with email + code, set
-- password, then log in). Required for the access-control feature on /welcome.
create table if not exists visitors (
  email text primary key,
  password_hash text not null,
  created_at timestamptz default now()
);
