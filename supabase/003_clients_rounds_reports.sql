-- Run this in Supabase: Dashboard → SQL Editor → New query → paste → Run.
--
-- Adds three things:
--   1. clients            — identity, linked to Quantemo's public.users
--   2. assessments.client_id / age_at_assessment — makes an assessment a ROUND
--   3. generated_reports  — the PDF files a round produced, in Storage
--
-- Safe to re-run. Additive only: no column is dropped and no existing row is
-- deleted. Every new column is nullable so the app keeps working between
-- running this and shipping the code that fills them in.
--
-- DO NOT use `prisma db push` to apply this. Quantemo's tables live in this
-- same database and are NOT in prisma/schema.prisma, so db push would try to
-- drop them. Run this SQL, then `npx prisma generate` (generate, not push).

-- ============================================================
-- 1. clients — who the person is
-- ============================================================
-- Deliberately thin. Name, email and age all live in Quantemo's public.users
-- and are read from there; copying them here would give this database two
-- customer lists that disagree within a week.
--
-- quantemo_uuid is nullable because existing assessments have no email to
-- resolve one from (see the backfill in step 4) — Postgres allows many NULLs
-- under a unique constraint, so unlinked clients don't collide.
--
-- No foreign key to public.users on purpose: that table belongs to Quantemo
-- and isn't managed by this project's schema. Link by value, look up in code.
create table if not exists clients (
  id bigint generated always as identity primary key,
  quantemo_uuid uuid unique,
  created_at timestamptz not null default now()
);

-- ============================================================
-- 2. assessments becomes a ROUND (one purchase), not one person
-- ============================================================
-- A client has many rounds. customer_id (the name read off the PDF) stays
-- exactly where it is: it's legitimately per-round data — it's what THAT
-- upload's PDF said — and it's the display name for clients not yet linked
-- to Quantemo.
alter table assessments add column if not exists client_id bigint references clients(id) on delete cascade;

-- Age is frozen per round, not stored on the client: a report generated in
-- February saying "age 42" must still say 42 when reopened next year, and
-- Quantemo's users.age changes with every birthday.
alter table assessments add column if not exists age_at_assessment integer;

create index if not exists assessments_client_idx on assessments (client_id);

-- ============================================================
-- 3. generated_reports — what was actually produced and delivered
-- ============================================================
-- Rows point at a file in Supabase Storage; the file itself is the durable
-- artifact. storage_path is kept predictable — reports/<assessment_id>/... —
-- so that if a row is ever lost, the file is still findable by round.
--
-- variant/theme mirror the query params app/api/generate-report already takes,
-- so a stored report can be regenerated with the same arguments.
create table if not exists generated_reports (
  id bigint generated always as identity primary key,
  assessment_id bigint not null references assessments(id) on delete cascade,
  variant text not null default 'full' check (variant in ('overview', 'full')),
  theme text check (theme in ('career', 'finance', 'relationship')),
  storage_path text not null,
  generated_at timestamptz not null default now(),
  -- Set when this is the copy a customer actually received. Staff regenerating
  -- while checking a fix produce undelivered rows that can be pruned.
  delivered boolean not null default false
);

create index if not exists generated_reports_assessment_idx on generated_reports (assessment_id);

-- ============================================================
-- 4. Backfill — give every existing assessment its own client
-- ============================================================
-- ONE client per existing assessment, deliberately NOT merged by name.
--
-- Auto-merging on customer_id would be wrong in both directions: this database
-- currently holds two rows called "Suleiman Yahaya" / "Suleiman Yahaya Kwande"
-- that may or may not be the same person, and six rows named after PDF
-- filenames that are not people at all. Merging is a human decision, made
-- afterwards by pointing two assessments at the same client_id.
-- Row-at-a-time so each new client is tied to its own assessment with no
-- reliance on ordering tricks. Idempotent: a second run finds no NULLs and
-- does nothing.
do $$
declare
  a record;
  new_client_id bigint;
begin
  for a in select id, created_at from assessments where client_id is null order by id loop
    insert into clients (created_at) values (a.created_at) returning id into new_client_id;
    update assessments set client_id = new_client_id where id = a.id;
  end loop;
end $$;
