"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { back, dbMessage, normalizePhone, shopContext, waLink } from "@/lib/shop";

const base = (o: string) => `/app/${o}/clientes`;

export async function saveCustomer(form: FormData) {
  const org = String(form.get("org")), path = base(org);
  const { supabase } = await shopContext(org, "customers");
  const p = z.object({ name: z.string().trim().min(1).max(100), phone: z.string().trim(), email: z.string().trim().email().or(z.literal("")) }).safeParse(Object.fromEntries(form));
  const norm = p.success ? normalizePhone(p.data.phone) : null;
  if (!p.success || !norm) return back(path, "error", "Informe nome e um telefone válido com DDD.");
  const consent = form.get("consent") === "on";
  const { error } = await supabase.from("customers").insert({
    organization_id: org, name: p.data.name, phone: p.data.phone, phone_normalized: norm, email: p.data.email || null,
    marketing_consent: consent, marketing_consent_at: consent ? new Date().toISOString() : null });
  if (error) return back(path, "error", error.code === "23505" ? "Já existe um cliente com esse telefone." : dbMessage(error));
  revalidatePath(path); return back(path, "ok", "Cliente cadastrado.");
}

/** Logs the contact (only allowed with marketing consent) and then opens WhatsApp with a prefilled message. */
export async function contactCustomer(form: FormData) {
  const org = String(form.get("org")), id = String(form.get("id")), path = base(org);
  const { supabase, org: shop } = await shopContext(org, "customers");
  const { data: c } = await supabase.from("customers").select("name, phone_normalized, marketing_consent").eq("id", id).eq("organization_id", org).maybeSingle();
  if (!c) return back(path, "error", "Cliente não encontrado.");
  if (!c.marketing_consent) return back(path, "error", "Este cliente não autorizou receber mensagens de marketing.");
  const text = `Olá, ${c.name.split(" ")[0]}! Faz um tempinho desde sua última visita na ${shop.name}. Vamos agendar seu horário?`;
  const { error } = await supabase.rpc("record_contact", { p_org: org, p_customer: id, p_message: text });
  if (error) return back(path, "error", dbMessage(error));
  redirect(waLink(c.phone_normalized, text));
}
