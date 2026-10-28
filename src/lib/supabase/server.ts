import "server-only";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { getPublicEnv } from "@/lib/env";

/** Per-request client acting as the signed-in user, so RLS and the Master RPC checks apply. */
export async function createClient() {
  const store = await cookies();            // read first: marks the route as dynamic, never prerendered
  const env = getPublicEnv();
  if (!env) throw new Error("Supabase is not configured. See README → Variáveis de ambiente.");
  return createServerClient(env.url, env.anon, {
    cookies: {
      getAll: () => store.getAll(),
      setAll: (list) => {
        try { list.forEach(({ name, value, options }) => store.set(name, value, options)); } catch { /* called from a Server Component */ }
      },
    },
  });
}
