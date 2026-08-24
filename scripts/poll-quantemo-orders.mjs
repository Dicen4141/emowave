// Auto-imports new paid EmoWave orders on a timer — the "works today,
// before deployment" alternative to the real-time webhook (which needs
// EmoWave reachable from the public internet). This works right now
// because it's EmoWave reaching OUT to Quantemo on a schedule, same
// direction as the manual "+ Add to Workspace" button, just automatic.
//
// Run it and leave it running in its own terminal:
//   node scripts/poll-quantemo-orders.mjs
// Stop with Ctrl+C. Not meant to run forever unattended on its own — once
// EmoWave is deployed, switch to the real webhook (app/api/webhooks/quantemo-order)
// and retire this script.
import fs from "fs";

const envContent = fs.readFileSync(".env.local", "utf8");
for (const line of envContent.split("\n")) {
  const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
  if (m) process.env[m[1]] = m[2];
}

const POLL_INTERVAL_MS = 60_000; // 1 minute — orders aren't so time-sensitive that faster polling is worth the extra load

const { createClient } = await import("@supabase/supabase-js");
const quantemo = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.QUANTEMO_SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
const { processQuantemoOrder, listRecentEmowaveOrders } = await import("../lib/quantemoOrders.ts");

async function pollOnce() {
  const timestamp = new Date().toISOString();
  try {
    const buyers = await listRecentEmowaveOrders();
    const pending = buyers.flatMap((b) => b.pendingOrderIds.map((orderId) => ({ orderId, buyerName: b.buyerName })));
    if (pending.length === 0) {
      console.log(`[${timestamp}] No new orders.`);
      return;
    }
    for (const { orderId, buyerName } of pending) {
      const { data: order, error } = await quantemo
        .from("orders")
        .select("id, buyer_id, product_id, status, amount_rm, created_at, shipping_address, subject_profile_id")
        .eq("id", orderId)
        .maybeSingle();
      if (error || !order) {
        console.error(`[${timestamp}] Could not fetch order #${orderId}:`, error);
        continue;
      }
      const result = await processQuantemoOrder(order);
      console.log(`[${timestamp}] Order #${orderId} (${buyerName}) ->`, result);
    }
  } catch (err) {
    console.error(`[${timestamp}] Poll failed:`, err);
  }
}

console.log(`Polling Quantemo for new EmoWave orders every ${POLL_INTERVAL_MS / 1000}s. Ctrl+C to stop.`);
await pollOnce();
setInterval(pollOnce, POLL_INTERVAL_MS);
