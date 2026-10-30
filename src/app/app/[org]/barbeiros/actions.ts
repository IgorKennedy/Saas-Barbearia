"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { back, dbMessage, shopContext } from "@/lib/shop";

const base = (o: string) => `/app/${o}/barbeiros`;
const uuid = z.string().uuid();
const optPct = z.string().trim().transform((v) => (v === "" ? null : Number(v.replace(",", ".")))).refine((v) => v === null || (Number.isFinite(v) && v >= 0 && v <= 100));

export async function saveBarber(form: FormData) {
  const org = String(form.get("org")), path = base(org);
  const { supabase } = await shopContext(org, "barbers");
  const p = z.object({ id: uuid.or(z.literal("")), name: z.string().trim().min(1).max(80), phone: z.string().trim().max(30).optional(),
    commission: optPct, product: z.coerce.number().min(0).max(100) }).safeParse(Object.fromEntries(form));
  if (!p.success) return back(path, "error", "Confira nome e percentuais (0 a 100).");
  const row = { name: p.data.name, phone: p.data.phone || null, commission_pct: p.data.commission, product_commission_pct: p.data.product, is_active: form.get("active") !== "0" };
  let id = p.data.id;
  if (id) { const { error } = await supabase.from("barbers").update(row).eq("id", id).eq("organization_id", org); if (error) return back(path, "error", dbMessage(error)); }
  else { const { data, error } = await supabase.from("barbers").insert({ ...row, organization_id: org }).select("id").single(); if (error) return back(path, "error", dbMessage(error)); id = data.id; }

  // Services this barber performs, with optional barber×service commission override.
  const chosen = form.getAll("svc").map(String).filter((s) => uuid.safeParse(s).success);
  const links = chosen.map((service_id) => {
    const raw = String(form.get(`pct_${service_id}`) ?? "").trim(); const n = raw === "" ? null : Number(raw.replace(",", "."));
    return { barber_id: id, service_id, organization_id: org, commission_pct: n !== null && Number.isFinite(n) && n >= 0 && n <= 100 ? n : null };
  });
  const del = await supabase.from("barber_services").delete().eq("barber_id", id).eq("organization_id", org);
  if (del.error) return back(path, "error", dbMessage(del.error));
  if (links.length) { const ins = await supabase.from("barber_services").insert(links); if (ins.error) return back(path, "error", dbMessage(ins.error)); }
  revalidatePath(path); return back(path, "ok", "Barbeiro salvo.");
}

export async function payCommissions(form: FormData) {
  const org = String(form.get("org")), barber = String(form.get("barber")), path = base(org);
  const { supabase } = await shopContext(org, "commissions");
  if (!uuid.safeParse(barber).success) return back(path, "error", "Barbeiro inválido.");
  const { data, error } = await supabase.rpc("pay_commissions", { p_org: org, p_barber: barber });
  if (error) return back(path, "error", dbMessage(error));
  revalidatePath(path); return back(path, "ok", data > 0 ? "Comissões pagas e lançadas como despesa." : "Não há comissões pendentes.");
}
