import Link from "next/link";
import { dateIn, shopContext } from "@/lib/shop";
import { contactCustomer, saveCustomer } from "./actions";

type Row = { customer_id: string; name: string; phone: string; marketing_consent: boolean; visits_count: number; last_visit_at: string | null; avg_interval_days: number | null; next_expected_at: string | null; is_estimate: boolean; confidence: string; status: string };
const LABEL: Record<string, [string, string]> = { em_dia: ["Em dia", "text-ok"], proximo: ["Próximo do retorno", "text-warn"], atrasado: ["Atrasado", "text-bad"], inativo: ["Inativo", "text-muted"], sem_visitas: ["Sem visitas", "text-muted"] };
const CONF: Record<string, string> = { estimate: "estimativa geral", low: "confiança baixa", medium: "confiança média", high: "confiança alta", none: "" };

export default async function Customers({ params, searchParams }: { params: Promise<{ org: string }>; searchParams: Promise<{ ok?: string; error?: string; s?: string }> }) {
  const { org } = await params; const sp = await searchParams;
  const { supabase, tz } = await shopContext(org, "customers");
  const { data, error } = await supabase.rpc("customer_return_status", { p_org: org });
  const all = (data ?? []) as Row[];
  const rows = (sp.s && LABEL[sp.s] ? all.filter((r) => r.status === sp.s) : all).sort((a, b) => (a.next_expected_at ?? "9").localeCompare(b.next_expected_at ?? "9"));
  const count = (s: string) => all.filter((r) => r.status === s).length;
  return (
    <main className="max-w-5xl space-y-6">
      <h1 className="text-2xl font-semibold">Clientes</h1>
      <p className="text-sm text-muted">O intervalo de retorno é calculado sozinho a partir dos atendimentos <b>concluídos</b>. Cancelamentos e faltas não contam. Com poucas visitas a previsão é marcada como estimativa.</p>
      {sp.ok && <p role="status" className="text-sm text-ok">{sp.ok}</p>}
      {(sp.error || error) && <p role="alert" className="text-sm text-bad">{sp.error ?? "Não foi possível carregar os clientes."}</p>}
      <div className="flex flex-wrap gap-2 text-sm">
        <Link className="btn" href={`/app/${org}/clientes`}>Todos ({all.length})</Link>
        {Object.entries(LABEL).map(([k, [l]]) => <Link key={k} className="btn" href={`/app/${org}/clientes?s=${k}`}>{l} ({count(k)})</Link>)}
      </div>
      <div className="card overflow-x-auto"><table className="w-full text-left text-sm">
        <thead className="text-xs text-muted"><tr><th className="p-3">Cliente</th><th className="p-3">Visitas</th><th className="p-3">Última</th><th className="p-3">Volta a cada</th><th className="p-3">Próxima prevista</th><th className="p-3">Situação</th><th className="p-3">Remarketing</th></tr></thead>
        <tbody>{rows.map((r) => { const [l, cls] = LABEL[r.status] ?? [r.status, ""]; const act = ["proximo", "atrasado", "inativo"].includes(r.status);
          return (<tr key={r.customer_id} className="border-t border-line">
            <td className="p-3"><b>{r.name}</b><div className="text-xs text-muted">{r.phone}</div></td>
            <td className="p-3 tabular-nums">{r.visits_count}</td>
            <td className="p-3 tabular-nums">{r.last_visit_at ? dateIn(r.last_visit_at, tz) : "—"}</td>
            <td className="p-3">{r.avg_interval_days ? `${Math.round(Number(r.avg_interval_days))} dias` : "—"}<div className="text-xs text-muted">{CONF[r.confidence]}</div></td>
            <td className="p-3 tabular-nums">{r.next_expected_at ? dateIn(r.next_expected_at, tz) : "—"}{r.is_estimate && <div className="text-xs text-muted">estimada</div>}</td>
            <td className={`p-3 ${cls}`}>{l}</td>
            <td className="p-3">{act ? (r.marketing_consent
              ? <form action={contactCustomer}><input type="hidden" name="org" value={org} /><input type="hidden" name="id" value={r.customer_id} /><button className="btn">Chamar no WhatsApp</button></form>
              : <span className="text-xs text-muted">sem autorização</span>) : "—"}</td>
          </tr>); })}
          {rows.length === 0 && <tr><td colSpan={7} className="p-6 text-center text-muted">Nenhum cliente nesta lista.</td></tr>}</tbody></table></div>
      <section className="card max-w-xl p-5"><h2 className="mb-3 font-semibold">Novo cliente</h2>
        <form action={saveCustomer} className="grid gap-3 sm:grid-cols-2"><input type="hidden" name="org" value={org} />
          <label className="text-sm">Nome<input className="field mt-1" name="name" required /></label>
          <label className="text-sm">Telefone com DDD<input className="field mt-1" name="phone" required inputMode="tel" /></label>
          <label className="text-sm sm:col-span-2">E-mail (opcional)<input className="field mt-1" name="email" type="email" /></label>
          <label className="flex items-center gap-2 text-sm sm:col-span-2"><input type="checkbox" name="consent" className="size-4" /> O cliente autorizou receber mensagens de marketing</label>
          <button className="btn btn-primary sm:col-span-2">Cadastrar cliente</button></form></section>
    </main>);
}
