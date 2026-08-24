-- Run this in Supabase: Dashboard → SQL Editor → New query → paste → Run.

-- 1. Turn on pgvector (one-time, safe to re-run).
create extension if not exists vector;

-- 2. assessments — one row per client's voice-analysis submission.
--    This is the job-state-machine table: EmoWave waits on the recording +
--    vendor processing, so status tracks where a submission is.
create table if not exists assessments (
  id bigint generated always as identity primary key,
  customer_id text not null,
  fulfillment_type text,
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'ready', 'failed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- keep updated_at current whenever a row changes
create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists assessments_set_updated_at on assessments;
create trigger assessments_set_updated_at
before update on assessments
for each row execute function set_updated_at();

-- 3. report_facts — one row per extracted field (from the circle/template extractor).
--    `value` is jsonb, not plain text: prose fields store a plain string,
--    structured fields (L/R Brain, Vortex Energy, Stress type) store an
--    object — see the app-side mapping for which fields use which shape.
create table if not exists report_facts (
  id bigint generated always as identity primary key,
  assessment_id bigint not null references assessments(id) on delete cascade,
  source_report text not null,   -- e.g. "Aquera Mind Report", "Emotional Notes"
  section text not null,         -- e.g. "Sensory", "Inner Self", "Stress"
  label text not null,           -- e.g. "Public Self - full"
  value jsonb not null,
  -- ⚠ CONFIRM before running: this dimension must exactly match your
  -- embedding model's output size, or every insert will fail. If you call
  -- Gemini's embed API with output_dimensionality: 768, leave this as-is;
  -- if you use the model's default (currently 3072), change it to
  -- vector(3072) below.
  embedding vector(768),
  created_at timestamptz not null default now()
);

create index if not exists report_facts_assessment_idx on report_facts (assessment_id);

-- Vector similarity index — cosine distance, only pays off once rows have
-- embeddings populated (fine to create now, it'll just be empty until then).
create index if not exists report_facts_embedding_idx
  on report_facts using hnsw (embedding vector_cosine_ops);
