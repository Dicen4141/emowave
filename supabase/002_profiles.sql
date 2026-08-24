-- Run this in Supabase: Dashboard → SQL Editor → New query → paste → Run.
--
-- Supabase Auth already manages auth.users (email, hashed password,
-- sessions) — don't touch that table directly. This adds the one thing it
-- doesn't have: whether a logged-in user is an admin.

create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  is_admin boolean not null default false,
  created_at timestamptz not null default now()
);

-- Every new signup automatically gets a profiles row (is_admin defaults to
-- false) — so "how do I become admin" is a deliberate manual step (flip the
-- flag yourself in the Table Editor), never something a signup form grants.
create or replace function handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id) values (new.id);
  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- Row Level Security: a logged-in user can read their own profile (needed
-- to check is_admin client-side); nobody can read anyone else's.
alter table profiles enable row level security;

drop policy if exists "read own profile" on profiles;
create policy "read own profile" on profiles
  for select using (auth.uid() = id);
