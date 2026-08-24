import { NextResponse } from "next/server";
import { getAdminUser } from "@/lib/adminAuth";
import { listRecentEmowaveOrders, processQuantemoOrder, type QuantemoOrder } from "@/lib/quantemoOrders";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

// Pulls every paid EmoWave order that hasn't been imported yet.
//
// This is the auto-import: the webhook can't work from localhost because
// Quantemo's Supabase can't reach a private address, but the reverse
// direction is fine — EmoWave calls OUT to Quantemo. So instead of waiting to
// be pushed, the admin pulls on load and on a timer, which needs no public
// URL, no tunnel and no deploy. When the webhook is eventually set up this
// stays useful as the backstop for anything a failed delivery missed.
export async function POST() {
  const adminUser = await getAdminUser();
  // Same gate as the manual per-order import: importing creates clients.
  // Returns ok:false rather than an error status so a non-superadmin's
  // workspace polling this quietly does nothing instead of showing a failure.
  if (adminUser?.role !== "superadmin") {
    return NextResponse.json({ ok: false, imported: 0, reason: "not a superadmin" });
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.QUANTEMO_SUPABASE_SERVICE_KEY;
  if (!url || !key) return NextResponse.json({ ok: false, imported: 0, reason: "Quantemo is not configured." });

  try {
    const buyers = await listRecentEmowaveOrders();
    const pending = buyers.flatMap((b) => b.pendingOrderIds);
    if (pending.length === 0) return NextResponse.json({ ok: true, imported: 0, assessmentIds: [] });

    const quantemo = createClient(url, key, { auth: { persistSession: false } });
    const { data } = await quantemo
      .from("orders")
      .select("id, buyer_id, product_id, status, amount_rm, created_at, shipping_address, subject_profile_id")
      .in("id", pending);

    const assessmentIds: string[] = [];
    // Sequential on purpose: two orders from the same buyer decide between
    // joining a round and opening a new version by reading what's already
    // there, so importing them concurrently would race on that decision.
    // Oldest first, so versions come out in purchase order.
    const orders = ((data ?? []) as QuantemoOrder[]).sort((a, b) => a.id - b.id);
    for (const order of orders) {
      try {
        const result = await processQuantemoOrder(order);
        if (result.ok) assessmentIds.push(result.assessmentId);
      } catch (err) {
        // One bad order shouldn't stop the rest arriving.
        console.error(`Auto-import failed for Quantemo order ${order.id}:`, err);
      }
    }

    return NextResponse.json({ ok: true, imported: assessmentIds.length, assessmentIds });
  } catch (err) {
    console.error("Quantemo auto-import failed:", err);
    return NextResponse.json({ ok: false, imported: 0, reason: err instanceof Error ? err.message : "Unknown error" });
  }
}
