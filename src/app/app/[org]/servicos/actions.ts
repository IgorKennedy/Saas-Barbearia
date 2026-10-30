"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { back, dbMessage, parseMoney, shopContext } from "@/lib/shop";

const base = (o: string) => `/app/${o}/servicos`;
const uuid = z.string().uuid();
const MAX = 2 * 1024 * 1024, TYPES: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };

export async function saveService(form: FormData) {
  const org = String(form.get("org")), path = base(org);
  const { supabase } = await shopContext(org, "services");
  const p = z.object({
    id: uuid.or(z.literal("")), name: z.string().trim().min(1).max(80), description: z.string().trim().max(300).optional(),
    duration: z.coerce.number().int().min(5).max(600), commission: z.coerce.number().min(0).max(100),
  }).safeParse(Object.fromEntries(form));
  const price = parseMoney(form.get("price")), cost = parseMoney(form.get("cost") || "0");
  if (!p.success || price === null || cost === null) return back(path, "error", "Confira nome, preço, duração e comissão.");
  const row = { name: p.data.name, description: p.data.description || null, price_cents: price, duration_minutes: p.data.duration, variable_cost_cents: cost, default_commission_pct: p.data.commission };
  const { error } = p.data.id ? await supabase.from("services").update(row).eq("id", p.data.id).eq("organization_id", org)
                              : await supabase.from("services").insert({ ...row, organization_id: org });
  if (error) return back(path, "error", dbMessage(error));
  revalidatePath(path); return back(path, "ok", "Serviço salvo.");
}

export async function toggleService(form: FormData) {
  const org = String(form.get("org")), id = String(form.get("id")), path = base(org);
  const { supabase } = await shopContext(org, "services");
  if (!uuid.safeParse(id).success) return back(path, "error", "Serviço inválido.");
  const { error } = await supabase.from("services").update({ is_active: form.get("active") === "1" }).eq("id", id).eq("organization_id", org);
  if (error) return back(path, "error", dbMessage(error));
  revalidatePath(path); return back(path, "ok", "Situação atualizada.");
}

export async function addPhoto(form: FormData) {
  const org = String(form.get("org")), id = String(form.get("id")), path = base(org), file = form.get("photo");
  const { supabase } = await shopContext(org, "services");
  if (!uuid.safeParse(id).success || !(file instanceof File) || file.size === 0) return back(path, "error", "Escolha uma imagem.");
  const ext = TYPES[file.type];
  if (!ext) return back(path, "error", "Formato inválido. Use PNG, JPG ou WebP.");
  if (file.size > MAX) return back(path, "error", "A imagem passa de 2 MB.");
  const { data: svc } = await supabase.from("services").select("photo_paths").eq("id", id).eq("organization_id", org).maybeSingle();
  if (!svc) return back(path, "error", "Serviço não encontrado.");
  if ((svc.photo_paths as string[]).length >= 10) return back(path, "error", "Limite de 10 fotos por serviço.");
  const key = `${org}/services/${id}/${crypto.randomUUID()}.${ext}`;
  const up = await supabase.storage.from("shop-media").upload(key, file, { contentType: file.type });
  if (up.error) return back(path, "error", "Não foi possível enviar a foto. Confirme se o bucket shop-media existe (rode o SQL completo).");
  const { error } = await supabase.from("services").update({ photo_paths: [...(svc.photo_paths as string[]), key] }).eq("id", id).eq("organization_id", org);
  if (error) { await supabase.storage.from("shop-media").remove([key]); return back(path, "error", dbMessage(error)); }
  revalidatePath(path); return back(path, "ok", "Foto adicionada.");
}

export async function removePhoto(form: FormData) {
  const org = String(form.get("org")), id = String(form.get("id")), key = String(form.get("key")), path = base(org);
  const { supabase } = await shopContext(org, "services");
  if (!uuid.safeParse(id).success || !key.startsWith(`${org}/services/${id}/`)) return back(path, "error", "Foto inválida.");
  const { data: svc } = await supabase.from("services").select("photo_paths").eq("id", id).eq("organization_id", org).maybeSingle();
  if (!svc) return back(path, "error", "Serviço não encontrado.");
  const { error } = await supabase.from("services").update({ photo_paths: (svc.photo_paths as string[]).filter((p) => p !== key) }).eq("id", id).eq("organization_id", org);
  if (error) return back(path, "error", dbMessage(error));
  await supabase.storage.from("shop-media").remove([key]);
  revalidatePath(path); return back(path, "ok", "Foto removida.");
}
