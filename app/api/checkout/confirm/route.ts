import { NextResponse } from "next/server";
import Stripe from "stripe";
import { supabaseAdmin, currentUser } from "@/lib/supabase/server";

export const runtime = "nodejs";

/**
 * Called when Stripe redirects the user back after paying. Verifies the
 * session directly with Stripe and grants credits.
 *
 * This exists so payment works even if the webhook is slow or not wired up.
 * It shares the webhook's idempotency key (the Stripe session id), so
 * whichever path runs second is a no-op.
 */
export async function POST(req: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  const { sessionId } = (await req.json()) as { sessionId?: string };
  if (!sessionId) return NextResponse.json({ error: "sessionId is required." }, { status: 400 });

  const secret = process.env.STRIPE_SECRET_KEY;
  if (!secret) return NextResponse.json({ error: "Payments are not configured." }, { status: 500 });

  const stripe = new Stripe(secret);

  let session: Stripe.Checkout.Session;
  try {
    session = await stripe.checkout.sessions.retrieve(sessionId);
  } catch {
    return NextResponse.json({ error: "Could not find that payment." }, { status: 404 });
  }

  const owner = session.client_reference_id ?? session.metadata?.user_id;
  if (owner !== user.id) {
    return NextResponse.json({ error: "That payment belongs to another account." }, { status: 403 });
  }

  if (session.payment_status !== "paid") {
    return NextResponse.json({ error: "That payment hasn't completed." }, { status: 402 });
  }

  const { data: credits, error } = await supabaseAdmin().rpc("grant_credits", {
    p_user: user.id,
    p_amount: 5,
    p_method: "stripe",
    p_event_id: `stripe:${session.id}`,
  });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, credits });
}
