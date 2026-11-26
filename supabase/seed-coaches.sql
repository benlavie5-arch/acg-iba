-- Run this AFTER you and Andrew have each signed in to the site once.
-- Signing in creates the auth user; this grants it coach rights.
--
-- Replace the two emails with the ones you each signed in with.

insert into coaches (user_id, name)
select id, 'Ben Lavie'   from auth.users where email = 'REPLACE_BEN_EMAIL'
on conflict (user_id) do nothing;

insert into coaches (user_id, name)
select id, 'Andrew Vu'   from auth.users where email = 'REPLACE_ANDREW_EMAIL'
on conflict (user_id) do nothing;

-- Check it worked:
--   select c.name, u.email from coaches c join auth.users u on u.id = c.user_id;
