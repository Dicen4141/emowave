import { NextResponse } from "next/server";
import { processQuantemoOrder, type QuantemoOrder } from "@/lib/quantemoOrders";

export const runtime = "nodejs";

// Fired by a Supabase Database Webhook on Quantemo's `orders` table (INSERT
// and UPDATE — an order is usually created pending and updated to "paid"
// once payment clears, so both events need watching). See the setup notes
// at the bottom of this file for the one-time dashboard configuration.
//
// Needs EmoWave deployed with a real public URL — Quantemo's Supabase
// servers can't reach "localhost". Until then, use the manual "+ Add to
// Workspace" button on the Clients page instead (app/api/quantemo-orders),
// which does the exact same thing via processQuantemoOrder() but doesn't
// need Quantemo to be able to call EmoWave.
type OrderWebhookPayload = {
  type: "INSERT" | "UPDATE" | "DELETE";
  table: string;
  record: QuantemoOrder | null;
};

export async function POST(req: Request) {
  // Supabase Database Webhooks let you attach a custom header with a shared
  // secret — this is the only thing standing between this endpoint and
  // anyone who finds the URL, since there's no EmoWave admin session on a
  // server-to-server call (this route is exempted from that check in
  // middleware.ts specifically because of that).
  const secret = req.headers.get("x-webhook-secret");
  if (!process.env.QUANTEMO_WEBHOOK_SECRET || secret !== process.env.QUANTEMO_WEBHOOK_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await req.json()) as OrderWebhookPayload;
  if (body.table !== "orders" || !body.record) {
    return NextResponse.json({ ok: true, skipped: "not an orders row" });
  }

  try {
    const result = await processQuantemoOrder(body.record);
    if (!result.ok) return NextResponse.json({ ok: true, skipped: result.reason });
    console.log(`Quantemo order ${body.record.id} -> assessment ${result.assessmentId} (${result.created ? "created" : "already existed"})`);
    return NextResponse.json({ ok: true, assessmentId: result.assessmentId });
  } catch (err) {
    console.error("Quantemo order webhook failed:", err);
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// --- One-time setup (Supabase dashboard, Quantemo's project) ---
// Database → Webhooks → Create a new webhook
//   Table: orders
//   Events: Insert, Update
//   Type: HTTP Request → POST
//   URL: https://<your-emowave-domain>/api/webhooks/quantemo-order
//   HTTP Headers: x-webhook-secret = <value of QUANTEMO_WEBHOOK_SECRET below>
//
// Add to .env.local (and wherever the production env vars are set):
//   QUANTEMO_WEBHOOK_SECRET=<a random string — see .env.local.example>
