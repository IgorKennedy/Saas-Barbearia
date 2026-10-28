import { requireMaster } from "@/lib/auth/guards";

export default async function Audit() {
  const { supabase } = await requireMaster();
  const { data: logs } = await supabase.from("admin_audit_logs")
    .select("id, action, entity_id, old_value, new_value, reason, created_at, organizations(name)").order("id", { ascending: false }).limit(100);
  return (
    <main className="max-w-5xl">
      <h1 className="mb-6 text-2xl font-semibold">Auditoria</h1>
      {(logs ?? []).length === 0 ? <p className="text-muted">Nenhuma alteração administrativa registrada ainda.</p> : (
        <ul className="space-y-2 text-sm">{(logs ?? []).map((l) => (
          <li key={l.id} className="card p-3">
            <p><span className="font-medium">{l.action}</span>{l.entity_id ? ` · ${l.entity_id}` : ""} <span className="text-muted">— {(l.organizations as unknown as { name: string } | null)?.name ?? "plataforma"} · {new Date(l.created_at).toLocaleString("pt-BR")}</span></p>
            <p className="mt-1 break-words text-xs text-muted">{JSON.stringify(l.old_value)} → {JSON.stringify(l.new_value)}{l.reason ? ` · ${l.reason}` : ""}</p>
          </li>))}</ul>
      )}
    </main>
  );
}
