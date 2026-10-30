import Link from "next/link";
import { shopContext } from "@/lib/shop";

const ROUTES: [string, string, string][] = [
  ["agenda", "agenda", "Agenda"], ["customers", "clientes", "Clientes"], ["services", "servicos", "Serviços"], ["barbers", "barbeiros", "Barbeiros e comissões"],
];

export default async function ShopLayout({ children, params }: { children: React.ReactNode; params: Promise<{ org: string }> }) {
  const { org: id } = await params;
  const { org, features } = await shopContext(id);
  return (
    <div className="min-h-screen md:grid md:grid-cols-[230px_1fr]">
      <nav aria-label="Barbearia" className="border-b border-line bg-sunken p-4 md:border-b-0 md:border-r">
        <p className="font-semibold">{org.name}</p>
        <p className="mb-4 text-xs text-muted">{org.status === "suspended" ? "Conta suspensa — somente consulta" : org.status === "trial" ? "Período de teste" : "Conta ativa"}</p>
        <ul className="flex gap-2 overflow-x-auto md:flex-col">
          <li><Link className="block rounded px-2 py-1.5 text-sm text-muted hover:bg-raised hover:text-text" href={`/app/${id}`}>Início</Link></li>
          {ROUTES.filter(([k]) => features.includes(k)).map(([, path, label]) => (
            <li key={path}><Link className="block whitespace-nowrap rounded px-2 py-1.5 text-sm text-muted hover:bg-raised hover:text-text" href={`/app/${id}/${path}`}>{label}</Link></li>
          ))}
        </ul>
        <Link className="mt-6 block text-xs text-muted underline" href="/app">Minhas barbearias</Link>
      </nav>
      <div className="min-w-0 px-5 py-8">{children}</div>
    </div>
  );
}
