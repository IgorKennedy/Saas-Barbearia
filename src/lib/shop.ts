import "server-only";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { requireUser } from "@/lib/auth/guards";

/** Loads the signed-in user's view of one organization. RLS still decides what data comes back. */
export async function shopContext(orgId: string, moduleKey?: string) {
  if (!z.string().uuid().safeParse(orgId).success) notFound();
  const { supabase, user } = await requireUser();
  const [{ data: org }, { data: feats }, { data: mem }, { data: settings }] = await Promise.all([
    supabase.from("organizations").select("id, name, slug, status").eq("id", orgId).maybeSingle(),
    supabase.rpc("my_enabled_features", { p_org: orgId }),
    supabase.from("organization_members").select("role").eq("organization_id", orgId).eq("user_id", user.id).eq("is_active", true).maybeSingle(),
    supabase.from("organization_settings").select("timezone").eq("organization_id", orgId).maybeSingle(),
  ]);
  if (!org) notFound();
  const features = (Array.isArray(feats) ? feats : []) as string[];
  if (moduleKey && !features.includes(moduleKey)) redirect(`/app/${orgId}?blocked=${moduleKey}`);
  return { supabase, user, org, features, role: (mem?.role ?? "master") as string, tz: settings?.timezone ?? "America/Sao_Paulo" };
}

export const brl = (cents: number) => (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

/** "45,50" or "45.50" → 4550 cents; null when invalid. */
export function parseMoney(v: FormDataEntryValue | null): number | null {
  const raw = String(v ?? "").trim();
  const n = Number(raw.includes(",") ? raw.replace(/\./g, "").replace(",", ".") : raw);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
}

export function back(path: string, kind: "ok" | "error", msg: string): never {
  redirect(`${path}${path.includes("?") ? "&" : "?"}${kind}=${encodeURIComponent(msg)}`);
}

export function dbMessage(e: { code?: string; message?: string }): string {
  const m = e.message ?? "";
  if (e.code === "23P01" || /exclusion/.test(m)) return "Horário indisponível: conflita com outro agendamento ou folga do barbeiro.";
  if (e.code === "42501" || /row-level security|forbidden|permission denied/.test(m))
    return "Sem permissão para isso. Verifique seu papel, se o módulo está ativo e se a conta não está suspensa.";
  if (e.code === "23505") return "Já existe um registro com esses dados.";
  if (e.code === "23503") return "Registro relacionado não encontrado.";
  if (e.code === "22023" || e.code === "23514") return m.replace(/^.*?:\s*/, "") || "Dados inválidos.";
  return "Não foi possível concluir a operação.";
}

function tzOffsetMs(date: Date, tz: string) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
    .formatToParts(date).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(date.getTime() / 1000) * 1000;
}
/** "YYYY-MM-DDTHH:mm" typed in the shop's timezone → real UTC instant. */
export function zonedToUtc(local: string, tz: string): Date {
  const guess = new Date(`${local}:00Z`);
  const first = guess.getTime() - tzOffsetMs(guess, tz);
  return new Date(guess.getTime() - tzOffsetMs(new Date(first), tz));
}
export const todayIn = (tz: string) => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date());
export function dayRange(day: string, tz: string): [string, string] {
  const next = new Date(`${day}T00:00:00Z`); next.setUTCDate(next.getUTCDate() + 1);
  return [zonedToUtc(`${day}T00:00`, tz).toISOString(), zonedToUtc(`${next.toISOString().slice(0, 10)}T00:00`, tz).toISOString()];
}
export const timeIn = (iso: string, tz: string) => new Intl.DateTimeFormat("pt-BR", { timeZone: tz, hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
export const dateIn = (iso: string, tz: string) => new Intl.DateTimeFormat("pt-BR", { timeZone: tz }).format(new Date(iso));

export function normalizePhone(v: string): string | null {
  const d = v.replace(/\D/g, "");
  const full = d.length === 10 || d.length === 11 ? `55${d}` : d;
  return /^\d{10,15}$/.test(full) ? full : null;
}
export const waLink = (phone: string, text: string) => `https://wa.me/${phone}?text=${encodeURIComponent(text)}`;
