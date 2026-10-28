import { notFound } from "next/navigation";
import { requireMaster } from "@/lib/auth/guards";
import { ConfirmSuspend } from "@/components/confirm-form";
import { setOrgFeature, setOrgPlan, setOrgStatus, setOrgTrial } from "../../actions";
import { z } from "zod";

type Row = { feature_key: string; name: string; globally_enabled: boolean; plan_allows: boolean; org_enabled: boolean; override: "none" | "grant" | "block"; reason: string | null; effective: boolean };
const STATUS: Record<string, string> = { trial: "Em teste", active: "Ativa", suspended: "Suspensa", cancelled: "Cancelada" };
const Pill = ({ on, label }: { on: boolean; label: string }) => <span className={on ? "text-ok" : "text-muted"}>{label}: {on ? "sim" : "não"}</span>;

export default async function OrganizationDetail({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ ok?: string; error?: string }> }) {
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) notFound();
  const sp = await searchParams;
  const { supabase } = await requireMaster();
  const [{ data: org }, { data: plans }, { data: matrix }, { data: logs }] = await Promise.all([
    supabase.from("organizations").select("*").eq("id", id).maybeSingle(),
    supabase.from("saas_plans").select("id, name").order("sort_order"),
    supabase.rpc("admin_org_feature_matrix", { p_org: id }),
    supabase.from("admin_audit_logs").select("id, actor_id, action, entity_id, old_value, new_value, reason, created_at").eq("organization_id", id).order("id", { ascending: false }).limit(30),
  ]);
  if (!org) notFound();
  const actorIds = [...new Set((logs ?? []).map((l) => l.actor_id).filter(Boolean))] as string[];
  const { data: actors } = actorIds.length ? await supabase.from("profiles").select("id, email").in("id", actorIds) : { data: [] };
  const emailOf = new Map((actors ?? []).map((a) => [a.id as string, a.email as string]));
  const rows = (matrix ?? []) as Row[];
  const day = (v: string | null) => (v ? v.slice(0, 10) : "");

  return (
    <main className="max-w-5xl">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold">{org.name}</h1>
        <p className="text-sm text-muted">/{org.slug} · {STATUS[org.status]}{org.suspension_reason ? ` · motivo: ${org.suspension_reason}` : ""}</p>
      </header>
      {sp.ok && <p role="status" className="mb-4 text-sm text-ok">{sp.ok}</p>}
      {sp.error && <p role="alert" className="mb-4 text-sm text-bad">{sp.error}</p>}

      <section className="mb-8 grid gap-4 md:grid-cols-3">
        <div className="card p-4">
          <h2 className="mb-2 text-sm font-semibold">Situação</h2>
          <div className="flex flex-wrap gap-2">
            {org.status === "suspended" || org.status === "cancelled" ? (
              <form action={setOrgStatus}><input type="hidden" name="org" value={id} /><input type="hidden" name="status" value="active" /><input type="hidden" name="reason" value="Reativada pelo Master" /><button className="btn btn-primary">Reativar conta</button></form>
            ) : <ConfirmSuspend orgId={id} orgName={org.name} action={setOrgStatus} />}
          </div>
        </div>
        <form action={setOrgPlan} className="card p-4">
          <h2 className="mb-2 text-sm font-semibold">Plano comercial</h2>
          <input type="hidden" name="org" value={id} />
          <select className="field mb-2" name="plan" defaultValue={org.plan_id ?? ""} aria-label="Plano">{(plans ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
          <button className="btn">Alterar plano</button>
        </form>
        <form action={setOrgTrial} className="card p-4">
          <h2 className="mb-2 text-sm font-semibold">Período de teste</h2>
          <input type="hidden" name="org" value={id} />
          <div className="mb-2 grid grid-cols-2 gap-2">
            <label className="text-xs text-muted">Início<input className="field mt-1" type="date" name="starts" defaultValue={day(org.trial_starts_at)} /></label>
            <label className="text-xs text-muted">Término<input className="field mt-1" type="date" name="ends" defaultValue={day(org.trial_ends_at)} /></label>
          </div>
          <button className="btn">Salvar período</button>
        </form>
      </section>

      <section>
        <h2 className="mb-1 text-lg font-semibold">Módulos</h2>
        <p className="mb-3 text-sm text-muted">Um módulo funciona quando está liberado globalmente, incluído no plano e ligado para a barbearia. “Liberar” ignora o plano; “Bloquear” desliga sempre. Dados nunca são apagados.</p>
        <ul className="space-y-2">
          {rows.map((r) => (
            <li key={r.feature_key} className="card p-4">
              <form action={setOrgFeature} className="flex flex-wrap items-center gap-x-5 gap-y-2">
                <input type="hidden" name="org" value={id} /><input type="hidden" name="key" value={r.feature_key} />
                <div className="min-w-48 flex-1">
                  <p className="font-medium">{r.name}</p>
                  <p className="text-xs"><span className={r.effective ? "text-ok" : "text-bad"}>{r.effective ? "Ativo" : "Inativo"}</span> · <Pill on={r.globally_enabled} label="global" /> · <Pill on={r.plan_allows} label="plano" /></p>
                </div>
                <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="enabled" defaultChecked={r.org_enabled} className="size-4 accent-brass" /> Ligado</label>
                <label className="text-sm"><span className="sr-only">Exceção</span>
                  <select className="field" name="override" defaultValue={r.override}><option value="none">Seguir o plano</option><option value="grant">Liberar (exceção)</option><option value="block">Bloquear (exceção)</option></select></label>
                <input className="field max-w-52" name="reason" placeholder="Motivo (opcional)" defaultValue={r.reason ?? ""} maxLength={300} aria-label={`Motivo para ${r.name}`} />
                <button className="btn">Salvar</button>
              </form>
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-10">
        <h2 className="mb-3 text-lg font-semibold">Histórico de alterações</h2>
        {(logs ?? []).length === 0 ? <p className="text-sm text-muted">Nenhuma alteração registrada.</p> : (
          <ul className="space-y-2 text-sm">
            {(logs ?? []).map((l) => (
              <li key={l.id} className="card p-3">
                <p><span className="font-medium">{l.action}</span>{l.entity_id ? ` · ${l.entity_id}` : ""} <span className="text-muted">— {new Date(l.created_at).toLocaleString("pt-BR")} por {emailOf.get(l.actor_id as string) ?? "sistema"}</span></p>
                <p className="mt-1 break-words text-xs text-muted">{JSON.stringify(l.old_value)} → {JSON.stringify(l.new_value)}{l.reason ? ` · ${l.reason}` : ""}</p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
