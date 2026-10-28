"use server";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireUser } from "@/lib/auth/guards";

const schema = z.object({
  name: z.string().trim().min(2).max(120),
  slug: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/, "Use letras minúsculas, números e hífens."),
});

export async function createShop(form: FormData) {
  const { supabase } = await requireUser();
  const parsed = schema.safeParse(Object.fromEntries(form));
  if (!parsed.success) redirect("/app?error=" + encodeURIComponent(parsed.error.issues[0].message));
  const { error } = await supabase.rpc("create_organization", { p_name: parsed.data.name, p_slug: parsed.data.slug });
  if (error) {
    const msg = error.code === "23505" ? "Esse endereço já está em uso." : "Não foi possível criar a barbearia.";
    redirect("/app?error=" + encodeURIComponent(msg));
  }
  redirect("/app");
}
