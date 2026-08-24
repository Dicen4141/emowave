import { createClient } from "@supabase/supabase-js";

// Quantemo (the store clients buy their reports through) runs on the SAME
// Supabase project as EmoWave's own Auth (NEXT_PUBLIC_SUPABASE_URL) — its
// public.users table holds each customer's age. Reading it needs the
// service-role key (bypasses Row Level Security) since the anon key EmoWave
// otherwise uses has no reason to see other customers' rows. Server-only:
// never expose QUANTEMO_SUPABASE_SERVICE_KEY to the browser.
let cachedClient: ReturnType<typeof createClient> | null = null;
function quantemoClient() {
  if (cachedClient) return cachedClient;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.QUANTEMO_SUPABASE_SERVICE_KEY;
  if (!url || !key) return null;
  cachedClient = createClient(url, key, { auth: { persistSession: false } });
  return cachedClient;
}

// The Journey Overview chart's 12 age-bracket labels, spanning from the
// client's current age (box 1) down to 0 (box 12) — a FIXED step size
// (age/12, rounded) either overshoots and clamps into a repeated "0, 0" at
// the end, or falls short and never reaches 0 at all; neither reads well.
// Distributing the drop across all 11 gaps instead (age * (11-i)/11,
// rounded per box) lands exactly on 0 at the last box, every time, with no
// clamping and no duplicate values. E.g. age 30 -> 30,27,25,22,20,...,0.
// Age 28 -> 28,25,23,20,18,15,13,10,8,5,3,0.
//
// The age fed in is now recomputed on every render (from date of birth where
// Quantemo has one — see ageFromDateOfBirth), so a report opened next year
// relabels to next year's brackets instead of staying frozen at signup age.
export function ageBracketLabels(age: number): string[] {
  return Array.from({ length: 12 }, (_, i) => String(Math.round((age * (11 - i)) / 11)));
}

export type QuantemoUser = { uuid: string; age: number | null; firstName: string | null; lastName: string | null };

// Quantemo's signup form asks for a date of birth but only persists the age it
// computes from it, so the birthday itself is lost and the number never moves
// again — a customer who registered at 30 still reads 30 years later (verified
// against live rows: stored 25 vs an IC-derived 27, stored 20 vs 24).
//
// This column is the fix, and is read defensively because it does not exist on
// public.users yet: Postgres fails the WHOLE select on an unknown column, so
// asking for it unconditionally would break every lookup until Quantemo ships
// the migration. The first miss flips this flag and every later call uses the
// narrower select.
const DOB_COLUMN = "date_of_birth";
let dobColumnMissing = false;

/**
 * Age by calendar year — the age the client TURNS this year, not their exact
 * age today (someone born 2002-11-02 reads 24 throughout 2026, including
 * before their November birthday).
 *
 * Client's own definition, and the right one for this use: the brackets label
 * whole years of a life on a chart, so shifting every label by one for part
 * of the year would make the same person's chart disagree with itself either
 * side of their birthday. Returns null if the date isn't usable.
 */
export function ageFromDateOfBirth(dob: string | Date): number | null {
  const born = dob instanceof Date ? dob : new Date(dob);
  if (Number.isNaN(born.getTime())) return null;
  const age = new Date().getFullYear() - born.getFullYear();
  return age >= 0 && age < 130 ? age : null;
}

/**
 * Ages the stored number forward by however long it has been sitting there.
 * Used only when there's no date of birth to work from: the stored age was
 * correct on the day the row was created, so adding the years since then gets
 * back to within a year of the truth — which side of their birthday they fall
 * is unknowable without the date. Better than a number that is provably years
 * stale, and it needs nothing from the customer.
 */
function ageAdjustedForDrift(age: number, createdAt: string | null): number {
  if (!createdAt) return age;
  const created = new Date(createdAt);
  if (Number.isNaN(created.getTime())) return age;
  // Calendar-year difference, to match ageFromDateOfBirth above — both paths
  // have to answer "how old this year" the same way, or a client would see
  // their age move simply because Quantemo started storing a birth date.
  const years = new Date().getFullYear() - created.getFullYear();
  return years > 0 ? age + years : age;
}

/**
 * Looks up a Quantemo customer by email — the only reliable match key
 * (Quantemo's own users table has duplicate names, e.g. multiple "Dixon
 * Lai" rows with different emails, confirmed against the client's table).
 *
 * `uuid` is what EmoWave stores to link a Client, NOT the email: an email can
 * be changed in Quantemo, and a stored copy would then point at an address
 * that no longer exists. Email is how you find someone; uuid is how you keep
 * hold of them. Name and age are returned for display/snapshot use only —
 * neither should be persisted as EmoWave's own copy of the truth.
 *
 * Returns null on no match, no config, or any lookup failure.
 */
type QuantemoUserRow = {
  uuid: string | null;
  age: number | null;
  first_name: string | null;
  last_name: string | null;
  created_at?: string | null;
  date_of_birth?: string | null;
};

const BASE_COLUMNS = "uuid, age, first_name, last_name, created_at";

export async function lookupQuantemoUser(email: string): Promise<QuantemoUser | null> {
  const client = quantemoClient();
  if (!client || !email) return null;
  try {
    const select = async (columns: string) =>
      client.from("users").select(columns).eq("email", email).maybeSingle();

    let { data, error } = await select(dobColumnMissing ? BASE_COLUMNS : `${BASE_COLUMNS}, ${DOB_COLUMN}`);
    // Postgres reports an unknown column as 42703 and rejects the whole
    // statement, so a missing date_of_birth has to be retried without it
    // rather than treated as "this customer wasn't found".
    if (error && !dobColumnMissing && (error.code === "42703" || error.message?.includes(DOB_COLUMN))) {
      dobColumnMissing = true;
      ({ data, error } = await select(BASE_COLUMNS));
    }
    if (error || !data) return null;

    const row = data as unknown as QuantemoUserRow;
    if (!row.uuid) return null;

    // Date of birth first — it's the only value that stays correct on its own.
    // Falling back to the stored age means falling back to a number that was
    // right once; drift-correcting it is the closest available approximation.
    const storedAge = typeof row.age === "number" ? row.age : null;
    const age =
      (row.date_of_birth ? ageFromDateOfBirth(row.date_of_birth) : null) ??
      (storedAge !== null ? ageAdjustedForDrift(storedAge, row.created_at ?? null) : null);

    return { uuid: row.uuid, age, firstName: row.first_name, lastName: row.last_name };
  } catch (err) {
    console.error("Quantemo user lookup failed:", err);
    return null;
  }
}

/**
 * Age-only form, kept because report rendering needs nothing else. Callers
 * fall back to whatever they already had (raw extracted age brackets, or no
 * age-based labels at all) — never block report generation on this.
 */
export async function lookupQuantemoAge(email: string): Promise<number | null> {
  return (await lookupQuantemoUser(email))?.age ?? null;
}

/**
 * Quantemo's own customer tier — free/member/coach/master/grandmaster/admin
 * — used by app/api/auth/sync-role to auto-grant EmoWave admin access to
 * anyone Quantemo already has marked "admin", instead of that needing a
 * separate manual step. This is a DIFFERENT role system from EmoWave's own
 * (Supabase Auth app_metadata.role, admin/superadmin) — the sync route is
 * what bridges the two, this is just the raw read.
 */
export async function lookupQuantemoRole(email: string): Promise<string | null> {
  const client = quantemoClient();
  if (!client || !email) return null;
  try {
    const { data, error } = await client.from("users").select("role").eq("email", email).maybeSingle();
    if (error || !data) return null;
    return (data as { role: string | null }).role;
  } catch (err) {
    console.error("Quantemo role lookup failed:", err);
    return null;
  }
}
