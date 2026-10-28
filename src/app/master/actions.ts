"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireMaster } from "@/lib/auth/guards";

const uuid = z.string().uuid();
const back = (path: string, kind: "ok" | "error", msg: string): never =>
  redirect(`${path}?${kind}=${encodeURIComponent(msg)}`);

function failMessage(code?: string, message?: string) {
  if (code === "42501") return "Você não tem permissão para essa ação.";
  if (code === "23505") return "Esse valor já está em uso.";
  if (code === "P0002") return message ?? "Registro não encontrado.";
  if (code === "22023") return message ?? "Dados inválidos.";
  return "Não foi possível concluir a operação.";
}

export async function setOrgFeature(form: FormData) {
  const { supabase } = await requireMaster();
  const parsed = z.object({
    org: uuid, key: z.string().regex(/^[a-z][a-z0-9_]*$/), override: z.enum(["none", "grant", "block"]),
    reason: z.string().trim().max(300).optional(),
  }).safeParse(Object.fromEntries(form));
  const path = `/master/organizations/${String(form.get("org"))}`;
  if (!parsed.success) return back(path, "error", "Dados inválidos.");
  const { org, key, override, reason } = parsed.data;
  const { error } = await supabase.rpc("admin_set_org_feature", {
    p_org: org, p_feature_key: key, p_enabled: form.get("enabled") === "on", p_override: override, p_reason: reason || null,
  });
  if (error) return back(path, "error", failMessage(error.code, error.message));
  revalidatePath(path);
  return back(path, "ok", "Módulo atualizado.");
}

export async function setOrgStatus(form: FormData) {
  const { supabase } = await requireMaster();
  const parsed = z.object({
    org: uuid, status: z.enum(["trial", "active", "suspended", "cancelled"]), reason: z.string().trim().max(300).optional(),
  }).safeParse(Object.fromEntries(form));
  const path = `/master/organizations/${String(form.get("org"))}`;
  if (!parsed.success) return back(path, "error", "Dados inválidos.");
  const { error } = await supabase.rpc("admin_set_org_status", { p_org: parsed.data.org, p_status: parsed.data.status, p_reason: parsed.data.reason || null });
  if (error) return back(path, "error", failMessage(error.code, error.message));
  revalidatePath(path);
  return back(path, "ok", "Situação da conta atualizada.");
}

export async function setOrgPlan(form: FormData) {
  const { supabase } = await requireMaster();
  const parsed = z.object({ org: uuid, plan: uuid }).safeParse(Object.fromEntries(form));
  const path = `/master/organizations/${String(form.get("org"))}`;
  if (!parsed.success) return back(path, "error", "Dados inválidos.");
  const { error } = await supabase.rpc("admin_set_org_plan", { p_org: parsed.data.org, p_plan_id: parsed.data.plan, p_reason: null });
  if (error) return back(path, "error", failMessage(error.code, error.message));
  revalidatePath(path);
  return back(path, "ok", "Plano alterado.");
}

export async function setOrgTrial(form: FormData) {
  const { supabase } = await requireMaster();
  const parsed = z.object({ org: uuid, starts: z.string().date().or(z.literal("")), ends: z.string().date().or(z.literal("")) }).safeParse(Object.fromEntries(form));
  const path = `/master/organizations/${String(form.get("org"))}`;
  if (!parsed.success) return back(path, "error", "Datas inválidas.");
  const { org, starts, ends } = parsed.data;
  const { error } = await supabase.rpc("admin_set_org_trial", { p_org: org, p_starts: starts || null, p_ends: ends ? `${ends}T23:59:59-03:00` : null, p_reason: null });
  if (error) return back(path, "error", failMessage(error.code, error.message));
  revalidatePath(path);
  return back(path, "ok", "Período de teste atualizado.");
}

export async function createOrganization(form: FormData) {
  const { supabase } = await requireMaster();
  const parsed = z.object({
    name: z.string().trim().min(2).max(120),
    slug: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/),
    plan: uuid, email: z.string().email(), trial: z.coerce.number().int().min(0).max(365).optional(),
  }).safeParse(Object.fromEntries(form));
  if (!parsed.success) return back("/master/organizations", "error", "Confira nome, endereço, plano e e-mail do proprietário.");
  const { data, error } = await supabase.rpc("admin_create_organization", {
    p_name: parsed.data.name, p_slug: parsed.data.slug, p_plan_id: parsed.data.plan,
    p_owner_email: parsed.data.email, p_trial_days: parsed.data.trial ?? null,
  });
  if (error) return back("/master/organizations", "error", failMessage(error.code, error.message));
  redirect(`/master/organizations/${data}`);
}

export async function savePlan(form: FormData) {
  const { supabase } = await requireMaster();
  const parsed = z.object({
    id: uuid.or(z.literal("")), name: z.string().trim().min(2).max(80), description: z.string().trim().max(300).optional(),
    price: z.coerce.number().min(0).max(100000), trial: z.coerce.number().int().min(0).max(365),
    limits: z.string().trim().optional(),
  }).safeParse(Object.fromEntries(form));
  if (!parsed.success) return back("/master/plans", "error", "Confira os campos do plano.");
  let limits: unknown = {};
  try { limits = parsed.data.limits ? JSON.parse(parsed.data.limits) : {}; } catch { return back("/master/plans", "error", "Limites devem ser um JSON válido."); }
  const { data: planId, error } = await supabase.rpc("admin_save_plan", {
    p_id: parsed.data.id || null, p_name: parsed.data.name, p_description: parsed.data.description ?? null,
    p_price_cents: Math.round(parsed.data.price * 100), p_interval: "month", p_trial_days: parsed.data.trial,
    p_limits: limits, p_is_active: form.get("active") === "on",
  });
  if (error) return back("/master/plans", "error", failMessage(error.code, error.message));
  const keys = form.getAll("features").map(String);
  const { error: e2 } = await supabase.rpc("admin_set_plan_features", { p_plan: planId, p_keys: keys });
  if (e2) return back("/master/plans", "error", failMessage(e2.code, e2.message));
  revalidatePath("/master/plans");
  return back("/master/plans", "ok", "Plano salvo.");
}
