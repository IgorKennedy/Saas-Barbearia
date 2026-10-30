import Link from "next/link";
import { brl, dayRange, shopContext, timeIn, todayIn } from "@/lib/shop";
import { appointmentOp, bookAppointment } from "./actions";

const ST: Record<string, [string, string]> = { scheduled: ["Agendado", "text-muted"], confirmed: ["Confirmado", "text-ok"], in_progress: ["Em atendimento", "text-warn"], completed: ["Concluído", "text-ok"], cancelled: ["Cancelado", "text-bad"], no_show: ["Faltou", "text-bad"] };
type A = { id: string; customer_id: string; barber_id: string; starts_at: string; ends_at: string; status: string; total_cents: number };

export default async function Agenda({ params, searchParams }: { params: Promise<{ org: string }>; searchParams: Promise<{ d?: string; ok?: string; error?: string }> }) {
  const { org } = await params; const sp = await searchParams;
  const { supabase, tz, features } = await shopContext(org, "agenda");
  const day = /^\d{4}-\d{2}-\d{2}$/.test(sp.d ?? "") ? sp.d! : todayIn(tz);
  const [from, to] = dayRange(day, tz);
  const shift = (n: number) => { const d = new Date(`${day}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const [{ data: ap }, { data: cs }, { data: bs }, { data: sv }, { data: bsv }] = await Promise.all([
    supabase.from("appointments").select("id, customer_id, barber_id, starts_at, ends_at, status, total_cents").eq("organization_id", org).gte("starts_at", from).lt("starts_at", to).order("starts_at"),
    supabase.from("customers").select("id, name").eq("organization_id", org).order("name"),
    supabase.from("barbers").select("id, name").eq("organization_id", org).eq("is_active", true).order("name"),
    supabase.from("services").select("id, name, price_cents, duration_minutes").eq("organization_id", org).eq("is_active", true).order("name"),
    supabase.from("barber_services").select("barber_id, service_id").eq("organization_id", org),
  ]);
  const list = (ap ?? []) as A[]; const ids = list.map((a) => a.id);
  const { data: items } = ids.length ? await supabase.from("appointment_items").select("appointment_id, service_id").in("appointment_id", ids) : { data: [] };
  const cn = new Map((cs ?? []).map((c) => [c.id, c.name])), bn = new Map((bs ?? []).map((b) => [b.id, b.name])), sn = new Map((sv ?? []).map((s) => [s.id, s.name]));
  const svcOf = (id: string) => (items ?? []).filter((i) => i.appointment_id === id).map((i) => sn.get(i.service_id) ?? "serviço").join(" + ");
  const nowLocal = `${day}T09:00`;
  return (
    <main className="max-w-5xl space-y-6">
      <h1 className="text-2xl font-semibold">Agenda</h1>
      {sp.ok && <p role="status" className="text-sm text-ok">{sp.ok}</p>}
      {sp.error && <p role="alert" className="text-sm text-bad">{sp.error}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <Link className="btn" href={`/app/${org}/agenda?d=${shift(-1)}`}>← Dia anterior</Link>
        <form className="flex gap-2"><input className="field w-auto" type="date" name="d" defaultValue={day} aria-label="Dia" /><button className="btn">Ir</button></form>
        <Link className="btn" href={`/app/${org}/agenda?d=${shift(1)}`}>Próximo dia →</Link>
        <Link className="btn" href={`/app/${org}/agenda`}>Hoje</Link>
      </div>
      <section className="space-y-3">
        {list.length === 0 && <p className="card p-5 text-muted">Nenhum agendamento neste dia.</p>}
        {list.map((a) => { const [l, cls] = ST[a.status]; const open = ["scheduled", "confirmed", "in_progress"].includes(a.status);
          const op = (name: string, label: string, danger = false) => (<form action={appointmentOp}><input type="hidden" name="org" value={org} /><input type="hidden" name="day" value={day} /><input type="hidden" name="id" value={a.id} /><input type="hidden" name="op" value={name} /><button className={`btn ${danger ? "dng" : ""}`}>{label}</button></form>);
          return (<div key={a.id} className="card p-4"><div className="flex flex-wrap items-baseline justify-between gap-2">
            <p><b className="tabular-nums">{timeIn(a.starts_at, tz)}–{timeIn(a.ends_at, tz)}</b> · {cn.get(a.customer_id) ?? "Cliente"} <span className="text-muted">com {bn.get(a.barber_id) ?? "—"}</span></p>
            <p className={cls}>{l}</p></div>
            <p className="text-sm text-muted">{svcOf(a.id)} · {brl(a.total_cents)}</p>
            {open && <div className="mt-3 flex flex-wrap items-center gap-2">
              {a.status === "scheduled" && op("confirm", "Confirmar")}{a.status !== "in_progress" && op("start", "Iniciar")}
              <form action={appointmentOp} className="flex flex-wrap items-center gap-2"><input type="hidden" name="org" value={org} /><input type="hidden" name="day" value={day} /><input type="hidden" name="id" value={a.id} /><input type="hidden" name="op" value="complete" />
                <select name="pay" className="field w-auto" aria-label="Forma de pagamento"><option value="pix">Pix</option><option value="cash">Dinheiro</option><option value="card">Cartão</option></select>
                {features.includes("customer_plans") && <label className="flex items-center gap-1 text-xs text-muted"><input type="checkbox" name="sub" /> Usar benefício da assinatura</label>}
                <button className="btn btn-primary">Concluir atendimento</button></form>
              {op("noshow", "Faltou", true)}{op("cancel", "Cancelar", true)}</div>}
          </div>); })}
      </section>
      <section className="card p-5"><h2 className="mb-3 font-semibold">Novo agendamento</h2>
        {(cs ?? []).length === 0 || (bs ?? []).length === 0 || (sv ?? []).length === 0
          ? <p className="text-sm text-muted">Para agendar, cadastre ao menos um cliente, um barbeiro e um serviço (e vincule o serviço ao barbeiro).</p>
          : <form action={bookAppointment} className="grid gap-3 sm:grid-cols-3"><input type="hidden" name="org" value={org} /><input type="hidden" name="day" value={day} />
            <label className="text-sm">Cliente<select className="field mt-1" name="customer" required>{(cs ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
            <label className="text-sm">Barbeiro<select className="field mt-1" name="barber" required>{(bs ?? []).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></label>
            <label className="text-sm">Data e hora<input className="field mt-1" type="datetime-local" name="when" defaultValue={nowLocal} required /></label>
            <fieldset className="text-sm sm:col-span-3"><legend className="mb-1 text-muted">Serviços (a duração e o total são calculados automaticamente)</legend>
              <div className="grid gap-1 sm:grid-cols-2">{(sv ?? []).map((s) => <label key={s.id} className="flex items-center gap-2"><input type="checkbox" name="svc" value={s.id} className="size-4" />{s.name} <span className="text-muted">· {brl(s.price_cents)} · {s.duration_minutes} min</span></label>)}</div>
              <p className="mt-1 text-xs text-muted">O serviço precisa estar vinculado ao barbeiro (tela Barbeiros). Horários em conflito são recusados.</p></fieldset>
            <button className="btn btn-primary sm:col-span-3">Agendar</button></form>}
      </section>
    </main>);
}
