import { NextResponse } from "next/server";
import { listRecentEmowaveOrders } from "@/lib/quantemoOrders";

export const runtime = "nodejs";

// Read-only — any signed-in admin can see this (middleware already requires
// that for every /api/* route). Only the import action is superadmin-gated,
// matching the existing "only a superadmin adds a new client" rule.
export async function GET() {
  try {
    const buyers = await listRecentEmowaveOrders();
    return NextResponse.json({ buyers });
  } catch (err) {
    console.error("Failed to list Quantemo orders:", err);
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
