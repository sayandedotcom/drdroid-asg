import { NextResponse } from "next/server";
import Stripe from "stripe";
import { currentUser } from "@/lib/supabase/server";

export const runtime = "nodejs";

export async function POST() {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  const secret = process.env.STRIPE_SECRET_KEY;
  if (!secret) return NextResponse.json({ error: "Payments are not configured." }, { status: 500 });

  const stripe = new Stripe(secret);
  const origin = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    client_reference_id: user.id,
    customer_email: user.email ?? undefined,
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: 500,
          product_data: {
            name: "MicroManus — 5 research credits",
            description: "Unlocks the agent. Each credit runs one research request.",
          },
        },
      },
    ],
    metadata: { user_id: user.id },
    success_url: `${origin}/paywall?paid=1&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/paywall?canceled=1`,
  });

  return NextResponse.json({ url: session.url });
}
