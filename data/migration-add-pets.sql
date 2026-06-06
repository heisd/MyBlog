-- Pet system: each visitor can adopt tech-themed pets and level them up.
-- species: 'st' | 'esp' | 'linux' | 'arm' | 'sensor'
create table if not exists pets (
  id uuid primary key default gen_random_uuid(),
  owner_email text not null references visitors(email) on delete cascade,
  species text not null,
  name text not null,
  level int not null default 1,
  exp int not null default 0,
  created_at timestamptz default now(),
  last_fed_at timestamptz
);

create index if not exists pets_owner_idx on pets (owner_email, created_at);
