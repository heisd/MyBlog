-- Private messages (1:1 direct messages between two visitors).
-- A conversation is the set of messages where {sender,recipient} = the two users
-- (either direction). read_at is NULL until the recipient opens the thread.
-- deleted_by_* = the message is hidden for that side ("删除"); when both sides
-- have hidden it the row is hard-removed. "撤回" (recall) hard-deletes for both.
create table if not exists forum_messages (
  id uuid primary key default gen_random_uuid(),
  sender_email text not null references visitors(email) on delete cascade,
  recipient_email text not null references visitors(email) on delete cascade,
  content text not null,
  created_at timestamptz default now(),
  read_at timestamptz,
  deleted_by_sender boolean not null default false,
  deleted_by_recipient boolean not null default false
);

create index if not exists forum_messages_pair_idx on forum_messages (sender_email, recipient_email, created_at);
create index if not exists forum_messages_unread_idx on forum_messages (recipient_email, read_at);

-- 兼容已建表：补列
alter table forum_messages add column if not exists deleted_by_sender boolean not null default false;
alter table forum_messages add column if not exists deleted_by_recipient boolean not null default false;
