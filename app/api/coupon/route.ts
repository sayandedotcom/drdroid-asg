import crypto from "crypto";
import { NextResponse } from "next/server";
import { supabaseAdmin, currentUser } from "@/lib/supabase/server";

export const runtime = "nodejs";

function matches(a: string, b: string): boolean {
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export async function POST(req: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  const { code } = (await req.json()) as { code?: string };
  const expected = process.env.COUPON_CODE || "SID_DRDROID";

  if (!code || !matches(code.trim(), expected)) {
    return NextResponse.json({ error: "That coupon code isn't valid." }, { status: 400 });
  }

  const admin = supabaseAdmin();

  const { data: profile } = await admin
    .from("profiles")
    .select("unlocked")
    .eq("id", user.id)
    .maybeSingle();

  if (profile?.unlocked) {
    return NextResponse.json({ error: "Your account is already unlocked." }, { status: 400 });
  }

  const { data: credits, error } = await admin.rpc("grant_credits", {
    p_user: user.id,
    p_amount: 5,
    p_method: "coupon",
    p_event_id: `coupon:${user.id}`,
  });

  // A grant that didn't land must not report success — the paywall would say
  // "5 credits added" and then redirect straight back to itself.
  if (error || typeof credits !== "number" || credits < 1) {
    console.error("coupon grant failed", { user: user.id, error, credits });
    return NextResponse.json(
      { error: "Could not add credits to your account. Please try again." },
      { status: 500 }
    );
  }

  return NextResponse.json({ ok: true, credits });
}
