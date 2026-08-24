import { NextResponse } from "next/server";
import { getAdminUser } from "@/lib/adminAuth";
import { processQuantemoOrder } from "@/lib/quantemoOrders";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

function quantemoClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.QUANTEMO_SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or QUANTEMO_SUPABASE_SERVICE_KEY.");
  return createClient(url, key, { auth: { persistSession: false } });
}

// Manual equivalent of the Quantemo order webhook — same underlying
// processQuantemoOrder(), just triggered by a button click instead of an
// automatic delivery. Exists because the webhook needs EmoWave deployed
// with a public URL; this works today from localhost since it's EmoWave
// reaching OUT to Quantemo to fetch the order, not Quantemo reaching in.
//
// Creating a client this way is the same action as "+ New client" in
// Workspace, so it gets the same superadmin-only gate.
export async function POST(_req: Request, { params }: { params: Promise<{ orderId: string }> }) {
  const adminUser = await getAdminUser();
  if (adminUser?.role !== "superadmin") {
    return NextResponse.json({ error: "Only a superadmin can add a new client." }, { status: 403 });
  }

  const { orderId } = await params;
  const id = Number(orderId);
  if (!Number.isInteger(id)) return NextResponse.json({ error: "Invalid order id." }, { status: 400 });

  try {
    const quantemo = quantemoClient();
    const { data: order, error } = await quantemo
      .from("orders")
      .select("id, buyer_id, product_id, status, amount_rm, created_at, shipping_address, subject_profile_id")
      .eq("id", id)
      .maybeSingle();
    if (error || !order) return NextResponse.json({ error: "Order not found in Quantemo." }, { status: 404 });

    const result = await processQuantemoOrder(order);
    if (!result.ok) return NextResponse.json({ error: result.reason }, { status: 400 });
    return NextResponse.json({ ok: true, assessmentId: result.assessmentId });
  } catch (err) {
    console.error("Manual Quantemo order import failed:", err);
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
