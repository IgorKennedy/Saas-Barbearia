import Link from "next/link";
import { requireMaster } from "@/lib/auth/guards";

export default async function MasterLayout({ children }: { children: React.ReactNode }) {
  await requireMaster();
  const nav = [["/master", "Visão geral"], ["/master/organizations", "Barbearias"], ["/master/plans", "Planos"], ["/master/audit", "Auditoria"]];
  return (
    <div className="min-h-screen md:grid md:grid-cols-[220px_1fr]">
      <nav aria-label="Master" className="border-b border-line bg-sunken p-4 md:border-b-0 md:border-r">
        <p className="mb-4 font-semibold">Barbify Master</p>
        <ul className="flex gap-3 md:flex-col">
          {nav.map(([href, label]) => <li key={href}><Link className="block rounded px-2 py-1.5 text-sm text-muted hover:bg-raised hover:text-text" href={href}>{label}</Link></li>)}
        </ul>
        <Link className="mt-6 block text-xs text-muted underline" href="/app">Ir para o app</Link>
      </nav>
      <div className="px-6 py-8">{children}</div>
    </div>
  );
}
