import { brl, shopContext } from "@/lib/shop";
import { addPhoto, removePhoto, saveService, toggleService } from "./actions";

type Svc = { id: string; name: string; description: string | null; price_cents: number; duration_minutes: number; variable_cost_cents: number; default_commission_pct: number; is_active: boolean; photo_paths: string[] };

function ServiceForm({ org, s }: { org: string; s?: Svc }) {
  const f = (n: string, label: string, v: string | number, extra: object = {}) => (
    <label className="text-sm">{label}<input className="field mt-1" name={n} defaultValue={v} {...extra} /></label>);
  return (
    <form action={saveService} className="grid gap-3 sm:grid-cols-3">
      <input type="hidden" name="org" value={org} /><input type="hidden" name="id" value={s?.id ?? ""} />
      {f("name", "Nome", s?.name ?? "", { required: true, maxLength: 80 })}
      {f("price", "Preço (R$)", s ? (s.price_cents / 100).toFixed(2).replace(".", ",") : "", { required: true, inputMode: "decimal" })}
      {f("duration", "Duração (min)", s?.duration_minutes ?? 30, { type: "number", min: 5, max: 600, required: true })}
      {f("cost", "Custo variável (R$)", s ? (s.variable_cost_cents / 100).toFixed(2).replace(".", ",") : "0,00", { inputMode: "decimal" })}
      {f("commission", "Comissão padrão (%)", s?.default_commission_pct ?? 0, { type: "number", min: 0, max: 100, step: "0.01" })}
      {f("description", "Descrição", s?.description ?? "", { maxLength: 300 })}
      <button className="btn btn-primary sm:col-span-3">{s ? "Salvar alterações" : "Cadastrar serviço"}</button>
    </form>);
}

export default async function Services({ params, searchParams }: { params: Promise<{ org: string }>; searchParams: Promise<{ ok?: string; error?: string }> }) {
  const { org } = await params; const sp = await searchParams;
  const { supabase } = await shopContext(org, "services");
  const { data } = await supabase.from("services").select("*").eq("organization_id", org).order("name");
  const list = (data ?? []) as Svc[];
  const url = (p: string) => supabase.storage.from("shop-media").getPublicUrl(p).data.publicUrl;
  return (
    <main className="max-w-4xl space-y-6">
      <h1 className="text-2xl font-semibold">Serviços</h1>
      {sp.ok && <p role="status" className="text-sm text-ok">{sp.ok}</p>}
      {sp.error && <p role="alert" className="text-sm text-bad">{sp.error}</p>}
      <section className="card p-5"><h2 className="mb-3 font-semibold">Novo serviço</h2><ServiceForm org={org} /></section>
      {list.length === 0 && <p className="text-muted">Nenhum serviço cadastrado ainda.</p>}
      {list.map((s) => (
        <section key={s.id} className="card p-5">
          <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="font-semibold">{s.name} <span className="text-sm font-normal text-muted">· {brl(s.price_cents)} · {s.duration_minutes} min {s.is_active ? "" : "· inativo"}</span></h2>
            <form action={toggleService}><input type="hidden" name="org" value={org} /><input type="hidden" name="id" value={s.id} /><input type="hidden" name="active" value={s.is_active ? "0" : "1"} /><button className="btn">{s.is_active ? "Desativar" : "Ativar"}</button></form>
          </div>
          <ServiceForm org={org} s={s} />
          <h3 className="mb-2 mt-5 text-sm font-semibold">Fotos dos cortes ({s.photo_paths.length}/10)</h3>
          <div className="flex flex-wrap gap-3">
            {s.photo_paths.map((p) => (
              <form key={p} action={removePhoto} className="w-28">
                <input type="hidden" name="org" value={org} /><input type="hidden" name="id" value={s.id} /><input type="hidden" name="key" value={p} />
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={url(p)} alt={`Foto de ${s.name}`} className="mb-1 h-28 w-28 rounded object-cover" />
                <button className="btn w-full text-xs">Remover</button>
              </form>))}
          </div>
          <form action={addPhoto} className="mt-3 flex flex-wrap items-center gap-2">
            <input type="hidden" name="org" value={org} /><input type="hidden" name="id" value={s.id} />
            <input type="file" name="photo" accept="image/png,image/jpeg,image/webp" required className="text-sm" aria-label={`Foto para ${s.name}`} />
            <button className="btn">Enviar foto (até 2 MB)</button>
          </form>
        </section>))}
    </main>);
}
