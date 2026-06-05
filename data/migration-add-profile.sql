-- User profile: avatar + self-introduction (bio).
-- avatar_url stores a small image as a data URL (the client resizes/compresses
-- to a ~96px square before sending) or an https URL; bio is a short text.
alter table visitors add column if not exists avatar_url text;
alter table visitors add column if not exists bio text;
