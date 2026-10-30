import { shopContext } from "@/lib/shop";

const SOON = ["Prateleira e estoque", "Financeiro", "Relatórios mensais", "Planos de assinatura", "Calculadora de preço"];

export default async function ShopHome({ params, searchParams }: { params: Promise<{ org: string }>; searchParams: Promise<{ blocked?: string }> }) {
  const { org: id } = await params; const sp = await searchParams;
  const { org, features, role } = await shopContext(id);
  return (
    <main className="max-w-3xl">
      <h1 className="mb-1 text-2xl font-semibold">{org.name}</h1>
      <p className="mb-6 text-sm text-muted">Seu papel: {role}. Módulos ativos: {features.length}.</p>
      {sp.blocked && <p role="alert" className="mb-4 rounded border border-line p-3 text-sm text-warn">Esse módulo não está disponível para esta barbearia.</p>}
      <div className="card p-5">
        <h2 className="mb-2 font-semibold">Em construção</h2>
        <p className="text-sm text-muted">As regras do banco já existem e estão testadas; as telas ainda não: {SOON.join(", ")}.</p>
      </div>
    </main>
  );
}
