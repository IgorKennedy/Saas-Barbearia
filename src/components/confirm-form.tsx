"use client";
import { useRef } from "react";

/** Destructive action with an explicit confirmation step and a required reason. */
export function ConfirmSuspend({ orgId, orgName, action }: { orgId: string; orgName: string; action: (f: FormData) => void | Promise<void> }) {
  const dialog = useRef<HTMLDialogElement>(null);
  return (
    <>
      <button type="button" className="btn btn-danger" onClick={() => dialog.current?.showModal()}>Suspender conta</button>
      <dialog ref={dialog} aria-labelledby="suspend-title" className="card m-auto w-full max-w-md bg-raised p-6 text-text backdrop:bg-black/60">
        <form action={action} className="flex flex-col gap-3">
          <h2 id="suspend-title" className="text-lg font-semibold">Suspender {orgName}?</h2>
          <p className="text-sm text-muted">Os dados são preservados. A barbearia deixa de operar (novos registros e página pública), mas continua podendo consultar e exportar o que já tem. Você pode reativar a qualquer momento.</p>
          <input type="hidden" name="org" value={orgId} />
          <input type="hidden" name="status" value="suspended" />
          <label className="text-sm">Motivo (obrigatório)<input className="field mt-1" name="reason" required minLength={3} maxLength={300} /></label>
          <div className="flex justify-end gap-2">
            <button type="button" className="btn" onClick={() => dialog.current?.close()}>Cancelar</button>
            <button className="btn btn-danger">Confirmar suspensão</button>
          </div>
        </form>
      </dialog>
    </>
  );
}
