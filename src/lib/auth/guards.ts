import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getPublicEnv } from "@/lib/env";

export async function requireUser() {
  await cookies();                       // always dynamic: never prerender an auth decision
  if (!getPublicEnv()) redirect("/setup");
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();   // validates the JWT with Supabase Auth
  if (!data.user) redirect("/login");
  return { supabase, user: data.user };
}

/** Master gate. Reads platform_admins through RLS (a user can only see their own row). */
export async function requireMaster() {
  const { supabase, user } = await requireUser();
  const { data } = await supabase.from("platform_admins").select("user_id").eq("user_id", user.id).maybeSingle();
  if (!data) redirect("/app");
  return { supabase, user };
}

/** Server-side module gate for pages and actions. The database enforces the same rule via RLS. */
export async function requireModule(orgId: string, key: string) {
  const { supabase, user } = await requireUser();
  const { data } = await supabase.rpc("my_enabled_features", { p_org: orgId });
  if (!Array.isArray(data) || !data.includes(key)) redirect("/app?blocked=" + encodeURIComponent(key));
  return { supabase, user };
}
