import { beforeAll, describe, expect, it } from "vitest";
import { addMember, admin, asUser, createUser, makeMaster, makeShop, resetDatabase } from "./helpers";

const DAY = 864e5;
const ago = (days: number) => new Date(Date.now() - days * DAY);
let master: string, owner: string, manager: string, u1: string, u2: string, ownerX: string;
let org: string, orgX: string, b1: string, b2: string, corte: string, barba: string;
let c: Record<string, string> = {};

const book = async (user: string, cust: string, barber: string, start: Date, services: string[], o = org) =>
  (await asUser(user, (q) => q("select public.create_appointment($1,$2,$3,$4,$5::uuid[]) as id", [o, cust, barber, start.toISOString(), services])))[0].id as string;
const complete = (user: string, appt: string, sub = false) =>
  asUser(user, (q) => q("select public.complete_appointment($1,'pix',$2) as id", [appt, sub]));
const visit = async (cust: string, barber: string, start: Date, services = [corte]) => complete(manager, await book(manager, cust, barber, start, services));
const customer = async (name: string, phone: string, o = org) =>
  (await admin("insert into public.customers (organization_id,name,phone,phone_normalized) values ($1,$2,$3,$3) returning id", [o, name, phone]))[0].id as string;
const m = (sql: string, params: unknown[] = []) => admin(sql, params);

beforeAll(async () => {
  resetDatabase();
  master = await makeMaster();
  [owner, manager, u1, u2, ownerX] = await Promise.all(["o", "m", "b1", "b2", "ox"].map((n) => createUser(`${n}@ops.test`)));
  org = await makeShop(owner, "Ops Shop", "ops-shop");
  orgX = await makeShop(ownerX, "Other Shop", "other-shop");
  await addMember(org, manager, "manager"); await addMember(org, u1, "barber"); await addMember(org, u2, "barber");
  b1 = (await m("insert into public.barbers (organization_id,user_id,name,product_commission_pct) values ($1,$2,'Barbeiro 1',10) returning id", [org, u1]))[0].id;
  b2 = (await m("insert into public.barbers (organization_id,user_id,name) values ($1,$2,'Barbeiro 2') returning id", [org, u2]))[0].id;
  corte = (await m("insert into public.services (organization_id,name,price_cents,duration_minutes,variable_cost_cents,default_commission_pct) values ($1,'Corte',4500,30,300,30) returning id", [org]))[0].id;
  barba = (await m("insert into public.services (organization_id,name,price_cents,duration_minutes,default_commission_pct) values ($1,'Barba',2500,20,30) returning id", [org]))[0].id;
  await m("insert into public.barber_services (barber_id,service_id,organization_id,commission_pct) values ($1,$2,$3,50),($1,$4,$3,null),($5,$2,$3,null),($5,$4,$3,null)", [b1, corte, org, barba, b2]);
  for (const n of ["ana", "bia", "caio", "dani", "edu", "fabi", "gabi"]) c[n] = await customer(n, "119" + Math.floor(Math.random() * 1e8));
});

describe("agenda: conflicts", () => {
  const t0 = new Date(Date.now() + 5 * DAY); t0.setUTCHours(13, 0, 0, 0);
  it("computes duration and total from the services", async () => {
    const id = await book(manager, c.ana, b1, t0, [corte, barba]);
    const [a] = await m("select starts_at, ends_at, total_cents from public.appointments where id=$1", [id]);
    expect(a.total_cents).toBe(7000);
    expect(+a.ends_at - +a.starts_at).toBe(50 * 60_000);
  });
  it("rejects an overlapping booking for the same barber", async () => {
    await expect(book(manager, c.bia, b1, new Date(+t0 + 20 * 60_000), [corte])).rejects.toThrow(/exclusion constraint/);
  });
  it("allows back-to-back bookings and parallel bookings with another barber", async () => {
    await book(manager, c.bia, b1, new Date(+t0 + 50 * 60_000), [corte]);
    await book(manager, c.caio, b2, t0, [corte]);
  });
  it("one of two simultaneous bookings for the same slot wins", async () => {
    const slot = new Date(+t0 + 3 * 3600_000);
    const r = await Promise.allSettled([book(manager, c.dani, b1, slot, [corte]), book(owner, c.edu, b1, slot, [corte])]);
    expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect(r.filter((x) => x.status === "rejected")).toHaveLength(1);
  });
  it("a cancelled appointment frees the slot", async () => {
    const slot = new Date(+t0 + 6 * 3600_000), id = await book(manager, c.ana, b1, slot, [corte]);
    await asUser(manager, (q) => q("select public.set_appointment_status($1,'cancelled')", [id]));
    await book(manager, c.bia, b1, slot, [corte]);
  });
  it("honours barber time off and service eligibility", async () => {
    const off = new Date(+t0 + 8 * 3600_000);
    await m("insert into public.barber_time_off (organization_id,barber_id,starts_at,ends_at) values ($1,$2,$3,$4)", [org, b2, off, new Date(+off + 3600_000)]);
    await expect(book(manager, c.ana, b2, new Date(+off + 600_000), [corte])).rejects.toThrow(/off at this time/);
    const other = (await m("insert into public.services (organization_id,name,price_cents,duration_minutes) values ($1,'Sem vínculo',1000,10) returning id", [org]))[0].id;
    await expect(book(manager, c.ana, b2, new Date(+t0 + 20 * 3600_000), [other])).rejects.toThrow(/unavailable for this barber/);
  });
  it("barbers manage only their own agenda", async () => {
    await expect(book(u1, c.ana, b2, new Date(+t0 + 22 * 3600_000), [corte])).rejects.toThrow(/forbidden/);
    const mine = await asUser(u1, (q) => q("select barber_id from public.appointments"));
    expect(mine.length).toBeGreaterThan(0);
    expect(new Set(mine.map((x) => x.barber_id))).toEqual(new Set([b1]));
  });
});

describe("completion, commissions and statuses", () => {
  it("only complete_appointment can complete (guard trigger), and cancelled/no-show cannot complete", async () => {
    const id = await book(manager, c.fabi, b2, ago(60), [corte]);
    await expect(m("update public.appointments set status='completed' where id=$1", [id])).rejects.toThrow(/complete_appointment/);
    await asUser(manager, (q) => q("select public.set_appointment_status($1,'no_show')", [id]));
    await expect(complete(manager, id)).rejects.toThrow(/cannot be completed/);
    expect(await m("select 1 from public.visits where appointment_id=$1", [id])).toHaveLength(0);
  });
  it("applies commission precedence and snapshots the result", async () => {
    await visit(c.gabi, b1, ago(80), [corte, barba]);   // barber×service 50%, barba → service default 30%
    const rows = await m("select rule,pct,amount_cents from public.commissions c join public.appointment_items i on i.id=c.appointment_item_id join public.services s on s.id=i.service_id where c.barber_id=$1 and c.base_cents in (4500,2500) order by base_cents desc", [b1]);
    expect(rows[0]).toMatchObject({ rule: "barber_service", amount_cents: 2250 });
    expect(rows[1]).toMatchObject({ rule: "service_default", amount_cents: 750 });
    await visit(c.fabi, b2, ago(70));
    expect((await m("select rule,amount_cents from public.commissions where barber_id=$1", [b2]))[0]).toMatchObject({ rule: "service_default", amount_cents: 1350 });
    await m("update public.barbers set commission_pct=40 where id=$1", [b2]);
    await visit(c.fabi, b2, ago(69));
    const r = await m("select rule,amount_cents from public.commissions where barber_id=$1 order by created_at", [b2]);
    expect(r.map((x) => x.rule)).toEqual(["service_default", "barber_default"]);
    expect(r[0].amount_cents).toBe(1350);                       // earlier commission untouched by the new rate
  });
  it("completing twice is idempotent: one visit, one income, one set of commissions", async () => {
    const id = await book(manager, c.edu, b1, ago(50), [corte]);
    const v1 = (await complete(manager, id))[0].id, v2 = (await complete(manager, id))[0].id;
    expect(v2).toBe(v1);
    expect(await m("select 1 from public.visits where appointment_id=$1", [id])).toHaveLength(1);
    expect(await m("select 1 from public.financial_transactions where source_type='appointment' and source_id=$1", [id])).toHaveLength(1);
    expect(await m("select 1 from public.commissions where appointment_id=$1", [id])).toHaveLength(1);
  });
  it("a financial source can never be recorded twice", async () => {
    const [t] = await m("select * from public.financial_transactions where source_type='appointment' limit 1");
    await expect(m("insert into public.financial_transactions (organization_id,kind,category,amount_cents,source_type,source_id) values ($1,'income','services',1,'appointment',$2)", [org, t.source_id])).rejects.toThrow(/duplicate key/);
  });
});

describe("return interval per customer", () => {
  it("averages the gaps between completed visits only", async () => {
    const cust = await customer("Retorno", "11911110000");
    for (const d of ["2026-08-01", "2026-08-22", "2026-09-12", "2026-10-03"]) await visit(cust, b1, new Date(`${d}T10:00:00Z`));
    const cancel = await book(manager, cust, b1, new Date("2026-10-10T10:00:00Z"), [corte]);
    await asUser(manager, (q) => q("select public.set_appointment_status($1,'cancelled')", [cancel]));
    const ns = await book(manager, cust, b1, new Date("2026-10-11T10:00:00Z"), [corte]);
    await asUser(manager, (q) => q("select public.set_appointment_status($1,'no_show')", [ns]));
    const [mt] = await m("select * from public.customer_metrics where customer_id=$1", [cust]);
    expect(mt).toMatchObject({ visits_count: 4, interval_count: 3, confidence: "medium", is_estimate: false });
    expect(Number(mt.avg_interval_days)).toBe(21);
    expect(new Date(mt.next_expected_at).toISOString()).toBe("2026-10-24T10:00:00.000Z");
    expect(mt.total_spent_cents).toBe("18000"); expect(mt.avg_ticket_cents).toBe(4500);
  });
  it("classifies customers and flags estimates when history is short", async () => {
    const mk = async (name: string, days: number[]) => { const id = await customer(name, "11" + Math.floor(Math.random() * 1e9)); for (const d of days) await visit(id, b2, ago(d)); return id; };
    const em = await mk("em-dia", [45, 24, 3]), prox = await mk("proximo", [60, 39, 18]), atr = await mk("atrasado", [72, 51, 30]), ina = await mk("inativo", [200]);
    const rows = await asUser(manager, (q) => q("select * from public.customer_return_status($1)", [org]));
    const st = (id: string) => rows.find((r) => r.customer_id === id);
    expect(st(em).status).toBe("em_dia"); expect(st(prox).status).toBe("proximo"); expect(st(atr).status).toBe("atrasado");
    expect(st(ina)).toMatchObject({ status: "inativo", is_estimate: true, confidence: "estimate" });
    expect(st(c.ana).status).toBe("sem_visitas");
  });
  it("remarketing requires explicit consent and is logged", async () => {
    await expect(asUser(manager, (q) => q("select public.record_contact($1,$2,'Oi!')", [org, c.gabi]))).rejects.toThrow(/not consented/);
    await m("update public.customers set marketing_consent=true, marketing_consent_at=now() where id=$1", [c.gabi]);
    await asUser(manager, (q) => q("select public.record_contact($1,$2,'Sentimos sua falta')", [org, c.gabi]));
    expect(await m("select 1 from public.customer_contacts where customer_id=$1", [c.gabi])).toHaveLength(1);
  });
});

describe("shelf, stock and sales", () => {
  let prod: string;
  it("stock changes only through movements and never goes negative", async () => {
    prod = (await asUser(manager, (q) => q("insert into public.products (organization_id,name,sku,cost_cents,price_cents,min_stock) values ($1,'Pomada','POM-1',1500,3500,3) returning id", [org])))[0].id;
    await expect(asUser(manager, (q) => q("update public.products set stock_qty=999 where id=$1", [prod]))).rejects.toThrow(/permission denied/);
    await expect(asUser(u1, (q) => q("insert into public.inventory_movements (organization_id,product_id,kind,qty,created_by) values ($1,$2,'entry',5,$3)", [org, prod, u1]))).rejects.toThrow(/row-level security/);
    await asUser(manager, (q) => q("insert into public.inventory_movements (organization_id,product_id,kind,qty,unit_cost_cents,created_by) values ($1,$2,'entry',10,1500,$3)", [org, prod, manager]));
    await expect(asUser(manager, (q) => q("insert into public.inventory_movements (organization_id,product_id,kind,qty,created_by) values ($1,$2,'loss',-11,$3)", [org, prod, manager]))).rejects.toThrow(/stock_qty_check/);
    expect((await m("select stock_qty from public.products where id=$1", [prod]))[0].stock_qty).toBe(10);
    await expect(m("update public.inventory_movements set qty=1")).rejects.toThrow(/append-only/);
  });
  it("sells at the server-side price, decrements stock, books income and product commission", async () => {
    const id = (await asUser(u1, (q) => q(`select public.register_sale($1,$2,null,$3::jsonb,'pix','k1') as id`, [org, b1, JSON.stringify([{ product_id: prod, qty: 3, price: 1 }])])))[0].id;
    expect((await m("select total_cents,status from public.sales where id=$1", [id]))[0]).toMatchObject({ total_cents: 10500, status: "paid" });
    expect((await m("select stock_qty from public.products where id=$1", [prod]))[0].stock_qty).toBe(7);
    expect((await m("select amount_cents from public.financial_transactions where source_type='sale' and source_id=$1", [id]))[0].amount_cents).toBe(10500);
    expect((await m("select amount_cents,rule from public.commissions where sale_id=$1", [id]))[0]).toMatchObject({ amount_cents: 1050, rule: "product_default" });
  });
  it("is idempotent per key and atomic on insufficient stock", async () => {
    const again = (await asUser(u1, (q) => q(`select public.register_sale($1,$2,null,$3::jsonb,'pix','k1') as id`, [org, b1, JSON.stringify([{ product_id: prod, qty: 3 }])])))[0].id;
    expect(await m("select 1 from public.sales where idempotency_key='k1'")).toHaveLength(1);
    expect(again).toBeTruthy();
    expect((await m("select stock_qty from public.products where id=$1", [prod]))[0].stock_qty).toBe(7);
    const before = (await m("select count(*)::int n from public.sales"))[0].n;
    await expect(asUser(u1, (q) => q(`select public.register_sale($1,$2,null,$3::jsonb) as id`, [org, b1, JSON.stringify([{ product_id: prod, qty: 8 }])]))).rejects.toThrow(/insufficient stock/);
    expect((await m("select count(*)::int n from public.sales"))[0].n).toBe(before);
  });
  it("only one of two simultaneous sales of the last unit succeeds", async () => {
    const p2 = (await m("insert into public.products (organization_id,name,cost_cents,price_cents,stock_qty) values ($1,'Última',100,900,1) returning id", [org]))[0].id;
    const sell = (u: string, b: string) => asUser(u, (q) => q(`select public.register_sale($1,$2,null,$3::jsonb) as id`, [org, b, JSON.stringify([{ product_id: p2, qty: 1 }])]));
    const r = await Promise.allSettled([sell(u1, b1), sell(u2, b2)]);
    expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect((await m("select stock_qty from public.products where id=$1", [p2]))[0].stock_qty).toBe(0);
  });
  it("refunds restore stock, cancel income and reverse commissions — once", async () => {
    const sale = (await m("select id from public.sales where idempotency_key='k1'"))[0].id;
    await asUser(manager, (q) => q("select public.refund_sale($1)", [sale]));
    await asUser(manager, (q) => q("select public.refund_sale($1)", [sale]));
    expect((await m("select stock_qty from public.products where id=$1", [prod]))[0].stock_qty).toBe(10);
    expect((await m("select status from public.financial_transactions where source_id=$1", [sale]))[0].status).toBe("canceled");
    expect((await m("select status from public.commissions where sale_id=$1", [sale]))[0].status).toBe("reversed");
  });
});

describe("finance, commissions payment and monthly report", () => {
  it("owner/manager see finance; barbers do not; system rows are immutable", async () => {
    expect((await asUser(manager, (q) => q("select count(*)::int n from public.financial_transactions")))[0].n).toBeGreaterThan(0);
    expect(await asUser(u1, (q) => q("select * from public.financial_transactions"))).toHaveLength(0);
    await asUser(manager, (q) => q("update public.financial_transactions set amount_cents=1 where source_type='appointment'"));
    expect((await m("select count(*)::int n from public.financial_transactions where amount_cents=1"))[0].n).toBe(0);
    await asUser(manager, (q) => q("insert into public.financial_transactions (organization_id,kind,category,description,amount_cents,created_by) values ($1,'expense','rent','Aluguel',200000,$2)", [org, manager]));
  });
  it("barbers see only their own commissions", async () => {
    const rows = await asUser(u2, (q) => q("select barber_id from public.commissions"));
    expect(rows.length).toBeGreaterThan(0); expect(new Set(rows.map((r) => r.barber_id))).toEqual(new Set([b2]));
  });
  it("pays pending commissions once and records the expense", async () => {
    const [{ s }] = await m("select sum(amount_cents)::int s from public.commissions where barber_id=$1 and status='pending'", [b2]);
    const paid = (await asUser(owner, (q) => q("select public.pay_commissions($1,$2) as p", [org, b2])))[0].p;
    expect(paid).toBe(s);
    expect((await asUser(owner, (q) => q("select public.pay_commissions($1,$2) as p", [org, b2])))[0].p).toBe(0);
    expect((await m("select amount_cents from public.financial_transactions where category='commissions'"))[0].amount_cents).toBe(s);
    await expect(asUser(manager, (q) => q("select public.pay_commissions($1,$2)", [orgX, b2]))).rejects.toThrow(/forbidden/);
  });
  it("monthly report separates sold, received, contribution margin and managerial result", async () => {
    const shop = await makeShop(await createUser("r@ops.test"), "Report Shop", "report-shop");
    const rb = (await m("insert into public.barbers (organization_id,name) values ($1,'R') returning id", [shop]))[0].id;
    const sv = (await m("insert into public.services (organization_id,name,price_cents,duration_minutes,variable_cost_cents,default_commission_pct) values ($1,'Corte',4500,30,300,30) returning id", [shop]))[0].id;
    await m("insert into public.barber_services (barber_id,service_id,organization_id) values ($1,$2,$3)", [rb, sv, shop]);
    const ro = (await m("select user_id from public.organization_members where organization_id=$1", [shop]))[0].user_id;
    const cu = await customer("Rep", "11922220000", shop);
    for (const d of ["2026-03-05T12:00:00Z", "2026-03-06T12:00:00Z"]) {
      const id = (await asUser(ro, (q) => q("select public.create_appointment($1,$2,$3,$4,$5::uuid[]) as id", [shop, cu, rb, d, [sv]])))[0].id;
      await asUser(ro, (q) => q("select public.complete_appointment($1,'pix',false)", [id]));
    }
    const rep = (await asUser(ro, (q) => q("select public.report_month($1,'2026-03-15') as r", [shop])))[0].r;
    expect(rep).toMatchObject({ month: "2026-03", gross_revenue_cents: 9000, variable_costs_cents: 600, commissions_generated_cents: 2700, contribution_margin_cents: 5700 });
    expect(rep.appointments.completed).toBe(2); expect(rep.new_customers).toBe(1); expect(rep.avg_ticket_cents).toBe(4500);
    expect(rep.by_service[0]).toMatchObject({ service: "Corte", count: 2, revenue_cents: 9000 });
    const cur = (await asUser(owner, (q) => q("select public.report_month($1,current_date) as r", [org])))[0].r;
    expect(cur.managerial_result_cents).toBe(cur.received_cents - cur.expenses_paid_cents);
    await expect(asUser(u1, (q) => q("select public.report_month($1,current_date)", [org]))).rejects.toThrow(/forbidden/);
  });
});

describe("client subscriptions", () => {
  it("consumes a benefit only on completion, once, and never beyond the limit", async () => {
    const plan = (await m("insert into public.subscription_plans (organization_id,name,price_cents,uses_per_period) values ($1,'2 cortes',8000,2) returning id", [org]))[0].id;
    const cu = await customer("Assinante", "11933330000");
    const sub = (await asUser(owner, (q) => q("select public.subscribe_customer($1,$2,$3) as id", [org, cu, plan])))[0].id;
    const tx = (await m("select id,status from public.financial_transactions where source_type='subscription_charge' and source_id=$1", [sub]))[0];
    expect(tx.status).toBe("pending");
    await asUser(owner, (q) => q("select public.confirm_receipt($1)", [tx.id]));
    expect((await m("select status from public.financial_transactions where id=$1", [tx.id]))[0].status).toBe("paid");

    const slot = (n: number) => { const d = new Date(Date.now() + (14 + n) * DAY); d.setUTCHours(9, 0, 0, 0); return d; };
    const [a1, a2, a3] = await Promise.all([1, 2, 3].map((n) => book(manager, cu, b1, slot(n), [corte])));
    expect((await m("select uses_in_period from public.customer_subscriptions where id=$1", [sub]))[0].uses_in_period).toBe(0);   // booking consumes nothing
    await complete(manager, a1, true); await complete(manager, a1, true);                                                           // repeat is a no-op
    await complete(manager, a2, true);
    expect((await m("select uses_in_period from public.customer_subscriptions where id=$1", [sub]))[0].uses_in_period).toBe(2);
    await expect(complete(manager, a3, true)).rejects.toThrow(/limit reached/);
    expect((await m("select status from public.appointments where id=$1", [a3]))[0].status).toBe("scheduled");                      // rolled back
    expect(await m("select 1 from public.financial_transactions where source_type='appointment' and source_id=any($1)", [[a1, a2]])).toHaveLength(0);
  });
});

describe("module gating, tenant isolation and suspension on operations", () => {
  it("a disabled module is blocked in reads and RPCs, data is preserved", async () => {
    await asUser(master, (q) => q("select public.admin_set_org_feature($1,'inventory',false,'none','teste')", [org]));
    expect(await asUser(owner, (q) => q("select * from public.products"))).toHaveLength(0);
    await expect(asUser(u1, (q) => q(`select public.register_sale($1,$2,null,'[{"product_id":"00000000-0000-0000-0000-000000000000","qty":1}]'::jsonb)`, [org, b1]))).rejects.toThrow(/forbidden/);
    expect((await m("select count(*)::int n from public.products where organization_id=$1", [org]))[0].n).toBeGreaterThan(0);
    await asUser(master, (q) => q("select public.admin_set_org_feature($1,'inventory',true,'none',null)", [org]));
    expect((await asUser(owner, (q) => q("select * from public.products"))).length).toBeGreaterThan(0);
  });
  it("another organization cannot read, book against or complete this shop's data", async () => {
    expect(await asUser(ownerX, (q) => q("select * from public.appointments"))).toHaveLength(0);
    expect(await asUser(ownerX, (q) => q("select * from public.commissions"))).toHaveLength(0);
    const any = (await m("select id from public.appointments where organization_id=$1 and status='scheduled' limit 1", [org]))[0].id;
    await expect(asUser(ownerX, (q) => q("select public.complete_appointment($1)", [any]))).rejects.toThrow(/forbidden/);
    await expect(asUser(ownerX, (q) => q("select public.create_appointment($1,$2,$3,now() + interval '30 day',$4::uuid[])", [orgX, c.ana, b1, [corte]]))).rejects.toThrow();
  });
  it("a suspended shop cannot book or sell but data stays readable", async () => {
    await asUser(master, (q) => q("select public.admin_set_org_status($1,'suspended','teste')", [org]));
    await expect(book(manager, c.ana, b1, new Date(Date.now() + 40 * DAY), [corte])).rejects.toThrow(/forbidden/);
    expect((await asUser(owner, (q) => q("select * from public.appointments"))).length).toBeGreaterThan(0);
    await asUser(master, (q) => q("select public.admin_set_org_status($1,'active',null)", [org]));
  });
});
