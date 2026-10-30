import { brl, shopContext } from "@/lib/shop";
import { payCommissions, saveBarber } from "./actions";

type B = { id: string; name: string; phone: string | null; commission_pct: number | null; product_commission_pct: number; is_active: boolean };
type Svc = { id: string; name: string };

export default async function Barbers({ params, searchParams }: { params: Promise<{ org: string }>; searchParams: Promise<{ ok?: string; error?: string }> }) {
  const { org } = await params; const sp = await searchParams;
  const { supabase, features } = await shopContext(org, "barbers");
  const withComm = features.includes("commissions");
  const [{ data: bs }, { data: svcs }, { data: links }, { data: pend }] = await Promise.all([
    supabase.from("barbers").select("*").eq("organization_id", org).order("name"),
    supabase.from("services").select("id, name").eq("organization_id", org).order("name"),
    supabase.from("barber_services").select("barber_id, service_id, commission_pct").eq("organization_id", org),
    withComm ? supabase.from("commissions").select("barber_id, amount_cents").eq("organization_id", org).eq("status", "pending") : Promise.resolve({ data: [] }),
  ]);
  const barbers = (bs ?? []) as B[], services = (svcs ?? []) as Svc[];
  const owed = (id: string) => ((pend ?? []) as { barber_id: string; amount_cents: number }[]).filter((c) => c.barber_id === id).reduce((s, c) => s + c.amount_cents, 0);

  const Form = ({ b }: { b?: B }) => (
    <form action={saveBarber} className="grid gap-3 sm:grid-cols-4">
      <input type="hidden" name="org" value={org} /><input type="hidden" name="id" value={b?.id ?? ""} />
      <label className="text-sm sm:col-span-2">Nome<input className="field mt-1" name="name" defaultValue={b?.name ?? ""} required maxLength={80} /></label>
      <label className="text-sm">Telefone<input className="field mt-1" name="phone" defaultValue={b?.phone ?? ""} /></label>
      <label className="text-sm">Situação<select className="field mt-1" name="active" defaultValue={b?.is_active === false ? "0" : "1"}><option value="1">Ativo</option><option value="0">Inativo</option></select></label>
      <label className="text-sm">Comissão do barbeiro (%)<input className="field mt-1" name="commission" defaultValue={b?.commission_pct ?? ""} placeholder="usar a do serviço" inputMode="decimal" /></label>
      <label className="text-sm">Comissão em produtos (%)<input className="field mt-1" name="product" type="number" min={0} max={100} step="0.01" defaultValue={b?.product_commission_pct ?? 0} /></label>
      <fieldset className="text-sm sm:col-span-4"><legend className="mb-1 text-muted">Serviços que realiza (e comissão específica, opcional)</legend>
        {services.length === 0 && <p className="text-muted">Cadastre serviços primeiro.</p>}
        <div className="grid gap-1 sm:grid-cols-2">{services.map((s) => {
          const l = (links ?? []).find((x) => x.barber_id === b?.id && x.service_id === s.id);
          return (<div key={s.id} className="flex items-center gap-2"><label className="flex flex-1 items-center gap-2"><input type="checkbox" name="svc" value={s.id} defaultChecked={!!l} className="size-4" />{s.name}</label>
            <input className="field w-24" name={`pct_${s.id}`} defaultValue={l?.commission_pct ?? ""} placeholder="% extra" aria-label={`Comissão específica em ${s.name}`} /></div>);
        })}</div></fieldset>
      <button className="btn btn-primary sm:col-span-4">{b ? "Salvar barbeiro" : "Cadastrar barbeiro"}</button>
    </form>);

  return (
    <main className="max-w-4xl space-y-6">
      <h1 className="text-2xl font-semibold">Barbeiros e comissões</h1>
      <p className="text-sm text-muted">Precedência da comissão: regra do barbeiro para o serviço → comissão do barbeiro → comissão padrão do serviço → 0%. O valor fica gravado no momento do atendimento; mudanças futuras não alteram o que já foi calculado.</p>
      {sp.ok && <p role="status" className="text-sm text-ok">{sp.ok}</p>}
      {sp.error && <p role="alert" className="text-sm text-bad">{sp.error}</p>}
      <section className="card p-5"><h2 className="mb-3 font-semibold">Novo barbeiro</h2><Form /></section>
      {barbers.length === 0 && <p className="text-muted">Nenhum barbeiro cadastrado ainda.</p>}
      {barbers.map((b) => (
        <section key={b.id} className="card p-5">
          <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="font-semibold">{b.name}{b.is_active ? "" : " (inativo)"}</h2>
            {withComm && <form action={payCommissions} className="flex items-center gap-3 text-sm"><span className="text-muted">A pagar: <b className="text-text">{brl(owed(b.id))}</b></span>
              <input type="hidden" name="org" value={org} /><input type="hidden" name="barber" value={b.id} /><button className="btn" disabled={owed(b.id) === 0}>Pagar comissões</button></form>}
          </div>
          <Form b={b} />
        </section>))}
    </main>);
}
