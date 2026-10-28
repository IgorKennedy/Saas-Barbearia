import Link from "next/link";
export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center gap-6 px-6">
      <h1 className="text-3xl font-semibold tracking-tight">Barbify</h1>
      <p className="text-muted">Agenda, clientes, financeiro e assinaturas para barbearias — cada uma com seus dados isolados e seus módulos.</p>
      <div className="flex gap-3">
        <Link className="btn btn-primary" href="/login">Entrar</Link>
        <Link className="btn" href="/login?mode=signup">Criar conta</Link>
      </div>
    </main>
  );
}
