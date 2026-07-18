import { redirect } from "next/navigation";
import { supabaseServer, currentUser } from "@/lib/supabase/server";
import PaywallForm from "./paywall-form";

export const dynamic = "force-dynamic";

export default async function PaywallPage({
  searchParams,
}: {
  searchParams: Promise<{ paid?: string; session_id?: string; canceled?: string }>;
}) {
  const user = await currentUser();
  if (!user) redirect("/");

  const params = await searchParams;
  const sb = await supabaseServer();
  const { data: profile } = await sb
    .from("profiles")
    .select("unlocked, credits")
    .eq("id", user.id)
    .maybeSingle();

  // Already unlocked and not mid-return from Stripe — nothing to do here.
  if (profile?.unlocked && params.paid !== "1") redirect("/settings");

  return (
    <main className="relative min-h-screen">
      <div
        aria-hidden
        className="pointer-events-none absolute -top-32 left-1/2 h-[28rem] w-[48rem] -translate-x-1/2 rounded-full opacity-[0.13] blur-[110px]"
        style={{ background: "radial-gradient(closest-side, #e2833c, transparent)" }}
      />
      <div className="relative mx-auto max-w-lg px-6 py-16 sm:py-24">
        <div className="mb-10 text-center">
          <p className="font-[family-name:var(--font-display)] text-lg">MicroManus</p>
          <p className="mt-1 text-xs text-ink-500">{user.email}</p>
        </div>

        <PaywallForm
          sessionId={params.paid === "1" ? params.session_id ?? null : null}
          canceled={params.canceled === "1"}
          alreadyUnlocked={Boolean(profile?.unlocked)}
        />
      </div>
    </main>
  );
}
