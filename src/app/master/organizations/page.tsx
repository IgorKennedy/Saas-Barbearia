import Link from "next/link";
import { requireMaster } from "@/lib/auth/guards";
import { createOrganization } from "../actions";

const STATUS: Record<string, string> = { trial: "Em teste", active: "Ativa", suspended: "Suspensa", cancelled: "Cancelada" };

export default async function Organizations({ searchParams }: { searchParams: Promise<{ q?: string; status?: string; ok?: string; error?: string }> }) {
  const { supabase } = await requireMaster();
  const sp = await searchParams;
  let query = supabase.from("organizations").select("id, name, slug, status, trial_ends_at, created_at, saas_plans(name)").order("created_at", { ascending: false });
  if (sp.status && STATUS[sp.status]) query = query.eq("status", sp.status as "trial");
  if (sp.q) query = query.or(`name.ilike.%${sp.q.replace(/[%,()]/g, "")}%,slug.ilike.%${sp.q.replace(/[%,()]/g, "")}%`);
  const [{ data: orgs }, { data: plans }] = await Promise.all([query, supabase.from("saas_plans").select("id, name").eq("is_active", true).order("sort_order")]);

  return (
    <main>
      <h1 className="mb-6 text-2xl font-semibold">Barbearias</h1>
      {sp.ok && <p role="status" className="mb-4 text-sm text-ok">{sp.ok}</p>}
      {sp.error && <p role="alert" className="mb-4 text-sm text-bad">{sp.error}</p>}
      <form className="mb-4 flex flex-wrap gap-2" role="search">
        <input className="field max-w-xs" name="q" defaultValue={sp.q} placeholder="Buscar por nome ou endereço" aria-label="Buscar barbearias" />
        <select className="field max-w-40" name="status" defaultValue={sp.status ?? ""} aria-label="Filtrar por situação">
          <option value="">Todas</option>{Object.entries(STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <button className="btn">Filtrar</button>
      </form>
      <div className="card overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="text-xs text-muted"><tr><th className="p-3">Nome</th><th className="p-3">Plano</th><th className="p-3">Situação</th><th className="p-3">Criada em</th></tr></thead>
          <tbody>
            {(orgs ?? []).map((o) => (
              <tr key={o.id} className="border-t border-line">
                <td className="p-3"><Link className="font-medium underline-offset-2 hover:underline" href={`/master/organizations/${o.id}`}>{o.name}</Link><div className="text-xs text-muted">/{o.slug}</div></td>
                <td className="p-3">{(o.saas_plans as unknown as { name: string } | null)?.name ?? "—"}</td>
                <td className="p-3">{STATUS[o.status]}</td>
                <td className="p-3 tabular-nums">{new Date(o.created_at).toLocaleDateString("pt-BR")}</td>
              </tr>
            ))}
            {(orgs ?? []).length === 0 && <tr><td colSpan={4} className="p-6 text-center text-muted">Nenhuma barbearia encontrada. Crie a primeira abaixo.</td></tr>}
          </tbody>
        </table>
      </div>
      <section className="card mt-8 max-w-xl p-5">
        <h2 className="mb-1 font-semibold">Criar conta manualmente</h2>
        <p className="mb-4 text-sm text-muted">O proprietário precisa já ter criado uma conta de acesso com o mesmo e-mail.</p>
        <form action={createOrganization} className="grid gap-3 sm:grid-cols-2">
          <label className="text-sm">Nome<input className="field mt-1" name="name" required minLength={2} /></label>
          <label className="text-sm">Endereço (slug)<input className="field mt-1" name="slug" required pattern="[a-z0-9][a-z0-9\-]{1,48}[a-z0-9]" /></label>
          <label className="text-sm">Plano<select className="field mt-1" name="plan" required>{(plans ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
          <label className="text-sm">Dias de teste<input className="field mt-1" name="trial" type="number" min={0} max={365} placeholder="padrão do plano" /></label>
          <label className="text-sm sm:col-span-2">E-mail do proprietário<input className="field mt-1" name="email" type="email" required /></label>
          <button className="btn btn-primary sm:col-span-2">Criar barbearia</button>
        </form>
      </section>
    </main>
  );
}
