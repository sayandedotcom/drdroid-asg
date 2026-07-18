import { redirect } from "next/navigation";
import { supabaseServer, supabaseAdmin, currentUser } from "@/lib/supabase/server";
import Sidebar from "./sidebar";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await currentUser();
  if (!user) redirect("/");

  const sb = await supabaseServer();
  const { data: profile } = await sb
    .from("profiles")
    .select("credits, unlocked")
    .eq("id", user.id)
    .maybeSingle();

  // The paywall is the gate for everything in this group.
  if (!profile?.unlocked) redirect("/paywall");

  const [{ data: chats }, { data: config }] = await Promise.all([
    sb.from("chats").select("id, title, created_at").order("created_at", { ascending: false }).limit(60),
    supabaseAdmin().from("llm_configs").select("default_model").eq("user_id", user.id).maybeSingle(),
  ]);

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar
        chats={chats ?? []}
        credits={profile.credits}
        email={user.email ?? ""}
        hasKey={Boolean(config)}
      />
      <div className="flex min-w-0 flex-1 flex-col">{children}</div>
    </div>
  );
}
