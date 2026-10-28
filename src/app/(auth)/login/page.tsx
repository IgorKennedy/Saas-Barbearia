import Link from "next/link";
import { AuthForm } from "./form";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ mode?: string; next?: string }> }) {
  const sp = await searchParams;
  const mode = sp.mode === "signup" ? "signup" : "login";
  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-5 px-6">
      <h1 className="text-2xl font-semibold">{mode === "signup" ? "Criar conta" : "Entrar"}</h1>
      <AuthForm mode={mode} next={sp.next ?? "/app"} />
      <Link className="text-sm text-muted underline" href={mode === "signup" ? "/login" : "/login?mode=signup"}>
        {mode === "signup" ? "Já tenho conta" : "Ainda não tenho conta"}
      </Link>
    </main>
  );
}
