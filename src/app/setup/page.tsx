export default function Setup() {
  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <h1 className="text-2xl font-semibold">Conecte o Supabase</h1>
      <p className="mt-3 text-muted">As variáveis <code>NEXT_PUBLIC_SUPABASE_URL</code> e <code>NEXT_PUBLIC_SUPABASE_ANON_KEY</code> ainda não foram definidas. Copie <code>.env.example</code> para <code>.env.local</code>, preencha com os valores do seu projeto e aplique as migrations de <code>supabase/migrations</code>. O passo a passo está no README.</p>
    </main>
  );
}
