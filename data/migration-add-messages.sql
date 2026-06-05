-- Private messages (1:1 direct messages between two visitors).
-- A conversation is the set of messages where {sender,recipient} = the two users
-- (either direction). read_at is NULL until the recipient opens the thread.
create table if not exists forum_messages (
  id uuid primary key default gen_random_uuid(),
  sender_email text not null references visitors(email) on delete cascade,
  recipient_email text not null references visitors(email) on delete cascade,
  content text not null,
  created_at timestamptz default now(),
  read_at timestamptz
);

create index if not exists forum_messages_pair_idx on forum_messages (sender_email, recipient_email, created_at);
create index if not exists forum_messages_unread_idx on forum_messages (recipient_email, read_at);
