// Grants (or invites) an EmoWave admin/superadmin account.
//
// Usage:
//   node scripts/create-admin.mjs <email> <admin|superadmin>
//
// If the email already has a Supabase Auth account (e.g. one created
// directly from the Supabase dashboard, or a Quantemo customer account on
// the same project), this just sets its role — the account's existing
// password is untouched. If no account exists yet, this sends a Supabase
// invite email with a link to app/admin/set-password so they can pick their
// own password, and the role is set at the same time.
//
// NOTE on a real bug found while building this: the Admin API's bulk
// list-users endpoint (GET /auth/v1/admin/users) returns a 500 "Database
// error finding users" on this project for any per_page above ~10, AND on
// its own ?email= filter — confirmed via direct fetch, not something wrong
// in this script. A handful of specific rows in the user list appear to be
// the trigger (narrowed it down: rows ~50-56 in the current list 500 no
// matter how they're paged). Fetching ONE row at a time (per_page=1) does
// NOT trip it, so that's what this script does to find a user by email —
// slower than a real search, but reliable. Worth reporting to Supabase
// support since it'll only get worse as more users are added; this is a
// workaround, not a fix.
import fs from "fs";

const envContent = fs.readFileSync(".env.local", "utf8");
for (const line of envContent.split("\n")) {
  const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
  if (m) process.env[m[1]] = m[2];
}

const [, , email, role] = process.argv;
if (!email || !["admin", "superadmin"].includes(role)) {
  console.error("Usage: node scripts/create-admin.mjs <email> <admin|superadmin>");
  process.exit(1);
}

const baseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.QUANTEMO_SUPABASE_SERVICE_KEY;
const headers = {
  apikey: serviceKey,
  Authorization: `Bearer ${serviceKey}`,
  "Content-Type": "application/json",
};

const MAX_ROWS = 5000;

async function findUserByEmail(targetEmail) {
  for (let row = 1; row <= MAX_ROWS; row++) {
    const res = await fetch(`${baseUrl}/auth/v1/admin/users?page=${row}&per_page=1`, { headers });
    if (!res.ok) continue; // skip whatever bad row is causing the 500, keep scanning
    const data = await res.json();
    if (data.users.length === 0) return null; // ran off the end of the list
    if (data.users[0].email?.toLowerCase() === targetEmail.toLowerCase()) return data.users[0];
  }
  throw new Error(`Scanned ${MAX_ROWS} rows without finding ${targetEmail} or reaching the end — aborting.`);
}

const existing = await findUserByEmail(email);

if (existing) {
  const res = await fetch(`${baseUrl}/auth/v1/admin/users/${existing.id}`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ app_metadata: { ...existing.app_metadata, role } }),
  });
  if (!res.ok) throw new Error(`updateUser failed: ${res.status} ${await res.text()}`);
  console.log(`Updated ${email} -> role "${role}" (existing account, password unchanged).`);
} else {
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
  const inviteRes = await fetch(`${baseUrl}/auth/v1/invite?redirect_to=${encodeURIComponent(`${siteUrl}/admin/set-password`)}`, {
    method: "POST",
    headers,
    body: JSON.stringify({ email }),
  });
  if (!inviteRes.ok) throw new Error(`invite failed: ${inviteRes.status} ${await inviteRes.text()}`);
  const invited = await inviteRes.json();
  const updateRes = await fetch(`${baseUrl}/auth/v1/admin/users/${invited.id}`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ app_metadata: { role } }),
  });
  if (!updateRes.ok) throw new Error(`updateUser failed: ${updateRes.status} ${await updateRes.text()}`);
  console.log(`Invited ${email} as "${role}" — check their inbox for the setup link.`);
  console.log(`(Redirect is set to ${siteUrl}/admin/set-password — make sure that URL is allow-listed in Supabase Auth > URL Configuration.)`);
}
