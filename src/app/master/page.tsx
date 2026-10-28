import { requireMaster } from "@/lib/auth/guards";

const brl = (cents: number) => (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

export default async function MasterDashboard() {
  const { supabase } = await requireMaster();
  const [{ data: orgs }, { data: plans }, { data: subs }, { data: pending }] = await Promise.all([
    supabase.from("organizations").select("id, status, plan_id, created_at"),
    supabase.from("saas_plans").select("id, name, price_cents"),
    supabase.from("saas_subscriptions").select("plan_id, status").eq("status", "active"),
    supabase.from("saas_payments").select("id").eq("status", "pending"),
  ]);
  const o = orgs ?? [];
  const count = (s: string) => o.filter((x) => x.status === s).length;
  const priceOf = new Map((plans ?? []).map((p) => [p.id, p.price_cents as number]));
  // MRR only counts subscriptions confirmed active by the payment provider (never trials).
  const mrr = (subs ?? []).reduce((sum, s) => sum + (priceOf.get(s.plan_id as string) ?? 0), 0);
  const since = Date.now() - 30 * 864e5;
  const stats: [string, string][] = [
    ["Barbearias", String(o.length)], ["Ativas", String(count("active"))], ["Em teste", String(count("trial"))],
    ["Suspensas", String(count("suspended"))], ["Canceladas", String(count("cancelled"))],
    ["Novas (30 dias)", String(o.filter((x) => new Date(x.created_at).getTime() > since).length)],
    ["Receita recorrente (MRR)", brl(mrr)], ["Pagamentos pendentes", String((pending ?? []).length)],
  ];
  return (
    <main>
      <h1 className="mb-6 text-2xl font-semibold">Visão geral</h1>
      <dl className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {stats.map(([k, v]) => <div key={k} className="card p-4"><dt className="text-xs text-muted">{k}</dt><dd className="mt-1 text-2xl font-semibold tabular-nums">{v}</dd></div>)}
      </dl>
      <section className="card mt-8 p-5">
        <h2 className="mb-3 font-semibold">Barbearias por plano</h2>
        {o.length === 0 ? <p className="text-sm text-muted">Nenhuma barbearia cadastrada ainda.</p> : (
          <ul className="space-y-1 text-sm">
            {(plans ?? []).map((p) => <li key={p.id} className="flex justify-between"><span>{p.name}</span><span className="tabular-nums">{o.filter((x) => x.plan_id === p.id).length}</span></li>)}
          </ul>
        )}
      </section>
      <p className="mt-6 text-xs text-muted">O MRR só considera assinaturas confirmadas pelo provedor de pagamento. Enquanto a cobrança não estiver configurada, o valor é zero.</p>
    </main>
  );
}
