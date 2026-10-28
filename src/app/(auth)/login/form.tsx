"use client";
import { useActionState } from "react";
import { authenticate, type AuthState } from "./actions";

export function AuthForm({ mode, next }: { mode: "login" | "signup"; next: string }) {
  const [state, action, pending] = useActionState<AuthState, FormData>(authenticate, {});
  return (
    <form action={action} className="card flex flex-col gap-4 p-6">
      <input type="hidden" name="mode" value={mode} />
      <input type="hidden" name="next" value={next} />
      {mode === "signup" && (
        <label className="text-sm">Nome<input className="field mt-1" name="full_name" autoComplete="name" /></label>
      )}
      <label className="text-sm">E-mail<input className="field mt-1" name="email" type="email" required autoComplete="email" /></label>
      <label className="text-sm">Senha<input className="field mt-1" name="password" type="password" required minLength={8} autoComplete={mode === "signup" ? "new-password" : "current-password"} /></label>
      {state.error && <p role="alert" className="text-sm text-bad">{state.error}</p>}
      {state.info && <p role="status" className="text-sm text-ok">{state.info}</p>}
      <button className="btn btn-primary" disabled={pending}>{pending ? "Aguarde…" : mode === "signup" ? "Criar conta" : "Entrar"}</button>
    </form>
  );
}
