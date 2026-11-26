-- ACG IBA roster backend
-- Paste this whole file into the Supabase SQL editor and run it once.
--
-- Access model:
--   coaches  -> read and write everything
--   members  -> read their own profile and their own mocks, nothing else
--   public   -> nothing at all
--
-- Security rests on row level security, not on the page. The anon key that
-- ships in the site is meant to be public; these policies are what actually
-- restrict access, so do not disable them.

-- ---------- tables ----------

create table if not exists coaches (
  user_id uuid primary key references auth.users(id) on delete cascade,
  name    text not null,
  added_at timestamptz not null default now()
);

create table if not exists members (
  id         text primary key,
  name       text not null,
  email      text unique,          -- how a member is matched to their login
  school     text,
  cohort     text,
  created_at timestamptz not null default now()
);

create table if not exists mocks (
  id        text primary key,
  member_id text not null references members(id) on delete cascade,
  date      date not null,
  coach     text,
  type      text,
  notes     text,
  answers   jsonb not null default '[]'::jsonb,
  logged_at timestamptz not null default now(),
  edited_at timestamptz
);

create index if not exists mocks_member_idx on mocks(member_id);
create index if not exists mocks_date_idx   on mocks(date desc);

-- ---------- who is a coach ----------
-- security definer so the check itself is not subject to the policies below,
-- which would otherwise recurse.

create or replace function is_coach()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (select 1 from coaches where user_id = auth.uid());
$$;

-- ---------- row level security ----------

alter table coaches enable row level security;
alter table members enable row level security;
alter table mocks   enable row level security;

-- coaches: a coach can see the coach list; nobody edits it from the client
drop policy if exists coaches_read on coaches;
create policy coaches_read on coaches
  for select using (is_coach());

-- members: coaches see all, a member sees only their own row
drop policy if exists members_read on members;
create policy members_read on members
  for select using (
    is_coach() or email = (auth.jwt() ->> 'email')
  );

drop policy if exists members_write on members;
create policy members_write on members
  for all using (is_coach()) with check (is_coach());

-- mocks: coaches see all, a member sees only mocks logged against them
drop policy if exists mocks_read on mocks;
create policy mocks_read on mocks
  for select using (
    is_coach()
    or member_id in (
      select id from members where email = (auth.jwt() ->> 'email')
    )
  );

drop policy if exists mocks_write on mocks;
create policy mocks_write on mocks
  for all using (is_coach()) with check (is_coach());
