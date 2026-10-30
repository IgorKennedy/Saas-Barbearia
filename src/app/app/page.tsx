import { requireUser } from "@/lib/auth/guards";
import { signOut } from "@/app/(auth)/login/actions";
import { createShop } from "./actions";

const LABEL: Record<string, string> = {
  agenda: "Agenda", customers: "Clientes", barbers: "Barbeiros", services: "Serviços",
  pricing_calculator: "Precificação", finance: "Financeiro", commissions: "Comissões", inventory: "Estoque",
  product_sales: "Vendas de produtos", customer_plans: "Planos de assinatura", upsell: "Upsell",
  advanced_reports: "Relatórios avançados", automations: "Automações", extra_units: "Unidades",
};

export default async function AppHome({ searchParams }: { searchParams: Promise<{ blocked?: string; error?: string }> }) {
  const { supabase, user } = await requireUser();
  const sp = await searchParams;
  const { data: memberships } = await supabase
    .from("organization_members").select("role, organizations(id, name, slug, status, trial_ends_at)").eq("is_active", true);
  const shops = await Promise.all((memberships ?? []).map(async (m) => {
    const org = m.organizations as unknown as { id: string; name: string; slug: string; status: string };
    const { data } = await supabase.rpc("my_enabled_features", { p_org: org.id });
    return { org, role: m.role as string, modules: (data ?? []) as string[] };
  }));
  const { data: isMaster } = await supabase.from("platform_admins").select("user_id").eq("user_id", user.id).maybeSingle();

  return (
    <main className="mx-auto max-w-4xl px-6 py-10">
      <header className="mb-8 flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Minhas barbearias</h1>
        <div className="flex gap-2">
          {isMaster && <a className="btn" href="/master">Painel Master</a>}
          <form action={signOut}><button className="btn">Sair</button></form>
        </div>
      </header>
      {sp.blocked && <p role="alert" className="mb-4 rounded border border-line p-3 text-sm text-warn">Esse módulo não está disponível para a sua barbearia. Fale com o suporte para ativá-lo.</p>}
      {sp.error && <p role="alert" className="mb-4 text-sm text-bad">{sp.error}</p>}
      {shops.length === 0 && <p className="card p-6 text-muted">Você ainda não faz parte de nenhuma barbearia. Crie a sua abaixo ou peça um convite ao proprietário.</p>}
      <ul className="grid gap-4 md:grid-cols-2">
        {shops.map(({ org, role, modules }) => (
          <li key={org.id} className="card p-5">
            <div className="flex items-baseline justify-between"><h2 className="font-semibold"><a className="underline-offset-2 hover:underline" href={`/app/${org.id}`}>{org.name}</a></h2><span className="text-xs text-muted">{role}</span></div>
            <p className="mt-1 text-xs text-muted">/{org.slug} · {org.status}</p>
            <p className="mt-4 text-xs text-muted">Módulos ativos</p>
            <p className="mt-1 text-sm">{modules.length ? modules.map((k) => LABEL[k] ?? k).join(", ") : "Nenhum módulo ativo."}</p>
            <a className="btn mt-4 inline-block" href={`/app/${org.id}`}>Abrir</a>
          </li>
        ))}
      </ul>
      <section className="card mt-10 max-w-md p-5">
        <h2 className="mb-3 font-semibold">Criar nova barbearia</h2>
        <form action={createShop} className="flex flex-col gap-3">
          <label className="text-sm">Nome<input className="field mt-1" name="name" required minLength={2} maxLength={120} /></label>
          <label className="text-sm">Endereço público (slug)<input className="field mt-1" name="slug" required pattern="[a-z0-9][a-z0-9\-]{1,48}[a-z0-9]" title="letras minúsculas, números e hífens" /></label>
          <button className="btn btn-primary">Criar e iniciar teste</button>
        </form>
      </section>
    </main>
  );
}
