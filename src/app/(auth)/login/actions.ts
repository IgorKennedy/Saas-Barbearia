"use server";
import { redirect } from "next/navigation";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";

const schema = z.object({
  email: z.string().email("Informe um e-mail válido."),
  password: z.string().min(8, "A senha precisa ter ao menos 8 caracteres."),
  full_name: z.string().trim().max(120).optional(),
});

export type AuthState = { error?: string; info?: string };

export async function authenticate(_: AuthState, form: FormData): Promise<AuthState> {
  const mode = form.get("mode") === "signup" ? "signup" : "login";
  const parsed = schema.safeParse(Object.fromEntries(form));
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  const supabase = await createClient();
  const { email, password, full_name } = parsed.data;

  if (mode === "signup") {
    const { data, error } = await supabase.auth.signUp({ email, password, options: { data: { full_name } } });
    if (error) return { error: "Não foi possível criar a conta. Verifique os dados e tente novamente." };
    if (!data.session) return { info: "Conta criada. Confirme o e-mail para entrar." };
  } else {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) return { error: "E-mail ou senha incorretos." };
  }
  const next = String(form.get("next") ?? "/app");
  redirect(next.startsWith("/") && !next.startsWith("//") ? next : "/app");
}

export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}
