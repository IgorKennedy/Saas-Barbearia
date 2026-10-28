import { requireMaster } from "@/lib/auth/guards";
import { savePlan } from "../actions";

export default async function Plans({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  const { supabase } = await requireMaster();
  const sp = await searchParams;
  const [{ data: plans }, { data: features }, { data: links }] = await Promise.all([
    supabase.from("saas_plans").select("*").order("sort_order"),
    supabase.from("features").select("key, name").order("sort_order"),
    supabase.from("saas_plan_features").select("plan_id, features(key)"),
  ]);
  const keysOf = (planId: string) => (links ?? []).filter((l) => l.plan_id === planId).map((l) => (l.features as unknown as { key: string }).key);
  const blank = { id: "", name: "", description: "", price_cents: 0, trial_days: 0, limits: {}, is_active: true };
  return (
    <main className="max-w-5xl">
      <h1 className="mb-1 text-2xl font-semibold">Planos do SaaS</h1>
      <p className="mb-6 text-sm text-muted">Preços e módulos são editáveis sem alterar o código. Os valores iniciais são ilustrativos.</p>
      {sp.ok && <p role="status" className="mb-4 text-sm text-ok">{sp.ok}</p>}
      {sp.error && <p role="alert" className="mb-4 text-sm text-bad">{sp.error}</p>}
      <div className="grid gap-4 lg:grid-cols-2">
        {[...(plans ?? []), blank].map((p) => (
          <form key={p.id || "new"} action={savePlan} className="card flex flex-col gap-3 p-5">
            <h2 className="font-semibold">{p.id ? p.name : "Novo plano"}</h2>
            <input type="hidden" name="id" value={p.id} />
            <label className="text-sm">Nome<input className="field mt-1" name="name" defaultValue={p.name} required /></label>
            <label className="text-sm">Descrição<input className="field mt-1" name="description" defaultValue={p.description ?? ""} /></label>
            <div className="grid grid-cols-2 gap-3">
              <label className="text-sm">Preço mensal (R$)<input className="field mt-1" name="price" type="number" step="0.01" min={0} defaultValue={(p.price_cents / 100).toFixed(2)} required /></label>
              <label className="text-sm">Dias de teste<input className="field mt-1" name="trial" type="number" min={0} defaultValue={p.trial_days} required /></label>
            </div>
            <label className="text-sm">Limites (JSON)<input className="field mt-1 font-mono" name="limits" defaultValue={JSON.stringify(p.limits)} /></label>
            <fieldset className="text-sm"><legend className="mb-1 text-muted">Módulos incluídos</legend>
              <div className="grid grid-cols-2 gap-1">{(features ?? []).map((f) => (
                <label key={f.key} className="flex items-center gap-2"><input type="checkbox" name="features" value={f.key} defaultChecked={p.id ? keysOf(p.id).includes(f.key) : false} className="size-4 accent-brass" />{f.name}</label>))}</div>
            </fieldset>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="active" defaultChecked={p.is_active} className="size-4 accent-brass" /> Disponível para novas contas</label>
            <button className="btn btn-primary">{p.id ? "Salvar plano" : "Criar plano"}</button>
          </form>
        ))}
      </div>
    </main>
  );
}
