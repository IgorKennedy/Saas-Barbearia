"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { back, dbMessage, shopContext, zonedToUtc } from "@/lib/shop";

const uuid = z.string().uuid();
const path = (o: string, d: string) => `/app/${o}/agenda?d=${d}`;

export async function bookAppointment(form: FormData) {
  const org = String(form.get("org")), day = String(form.get("day"));
  const { supabase, tz } = await shopContext(org, "agenda");
  const p = z.object({ customer: uuid, barber: uuid, when: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/) }).safeParse(Object.fromEntries(form));
  const services = form.getAll("svc").map(String).filter((s) => uuid.safeParse(s).success);
  if (!p.success || services.length === 0) return back(path(org, day), "error", "Escolha cliente, barbeiro, data/hora e ao menos um serviço.");
  const { error } = await supabase.rpc("create_appointment", { p_org: org, p_customer: p.data.customer, p_barber: p.data.barber, p_starts: zonedToUtc(p.data.when, tz).toISOString(), p_service_ids: services });
  if (error) return back(path(org, day), "error", dbMessage(error));
  revalidatePath(path(org, day)); return back(path(org, p.data.when.slice(0, 10)), "ok", "Agendamento criado.");
}

export async function appointmentOp(form: FormData) {
  const org = String(form.get("org")), day = String(form.get("day")), id = String(form.get("id")), op = String(form.get("op"));
  const { supabase } = await shopContext(org, "agenda");
  if (!uuid.safeParse(id).success) return back(path(org, day), "error", "Agendamento inválido.");
  const status: Record<string, string> = { confirm: "confirmed", start: "in_progress", cancel: "cancelled", noshow: "no_show" };
  const res = op === "complete"
    ? await supabase.rpc("complete_appointment", { p_appt: id, p_payment_method: String(form.get("pay") || "cash"), p_use_subscription: form.get("sub") === "on" })
    : status[op] ? await supabase.rpc("set_appointment_status", { p_appt: id, p_status: status[op] }) : { error: { message: "Ação inválida." } };
  if (res.error) return back(path(org, day), "error", dbMessage(res.error as { code?: string; message?: string }));
  revalidatePath(path(org, day)); return back(path(org, day), "ok", op === "complete" ? "Atendimento concluído: financeiro, comissões e retorno do cliente atualizados." : "Agendamento atualizado.");
}
