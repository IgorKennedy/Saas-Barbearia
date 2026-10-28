import { beforeAll, describe, expect, it } from "vitest";
import { addMember, admin, asUser, createUser, makeMaster, makeShop, planId, pool, resetDatabase } from "./helpers";

let master: string, ownerA: string, ownerB: string, managerA: string, barberA: string, stranger: string;
let blackBeard: string, domCorte: string;

beforeAll(async () => {
  resetDatabase();
  master = await makeMaster();
  ownerA = await createUser("owner.a@test");
  ownerB = await createUser("owner.b@test");
  managerA = await createUser("manager.a@test");
  barberA = await createUser("barber.a@test");
  stranger = await createUser("stranger@test");
  blackBeard = await makeShop(ownerA, "Black Beard", "black-beard");
  domCorte = await makeShop(ownerB, "Dom Corte", "dom-corte");
  await addMember(blackBeard, managerA, "manager");
  await addMember(blackBeard, barberA, "barber");
  for (const [org, label] of [[blackBeard, "BB"], [domCorte, "DC"]] as const) {
    await admin("insert into public.services (organization_id,name,price_cents,duration_minutes) values ($1,$2,4500,30)", [org, `Corte ${label}`]);
    await admin("insert into public.customers (organization_id,name,phone,phone_normalized) values ($1,$2,'(11) 90000-0000','11900000000')", [org, `Cliente ${label}`]);
    await admin("insert into public.subscription_plans (organization_id,name,price_cents,uses_per_period) values ($1,$2,12000,4)", [org, `Plano ${label}`]);
  }
});

describe("identity and privileges", () => {
  it("creates a profile on signup and grants no privileges", async () => {
    const rows = await admin("select email, full_name from public.profiles where id = $1", [ownerA]);
    expect(rows[0]).toMatchObject({ email: "owner.a@test", full_name: "owner.a" });
    expect(await admin("select 1 from public.platform_admins where user_id = $1", [ownerA])).toHaveLength(0);
  });

  it("a user cannot make themselves Master", async () => {
    await expect(asUser(stranger, (q) => q("insert into public.platform_admins (user_id) values ($1)", [stranger])))
      .rejects.toThrow(/permission denied/);
    await expect(asUser(stranger, (q) => q("update public.profiles set full_name='x' where id=$1", [stranger])))
      .resolves.toBeDefined();
  });

  it("Master RPCs reject non-Master callers, even owners", async () => {
    await expect(asUser(ownerA, (q) => q("select public.admin_set_org_status($1,'suspended','x')", [blackBeard])))
      .rejects.toThrow(/forbidden/);
    await expect(asUser(ownerA, (q) => q("select public.admin_set_org_feature($1,'finance',false,'none','x')", [blackBeard])))
      .rejects.toThrow(/forbidden/);
  });

  it("anonymous callers cannot execute admin RPCs or read tables", async () => {
    await expect(asUser(null, (q) => q("select public.admin_set_org_status($1,'active')", [blackBeard]))).rejects.toThrow(/permission denied/);
    await expect(asUser(null, (q) => q("select * from public.organizations"))).rejects.toThrow(/permission denied/);
  });

  it("owners cannot change status, plan or limits directly", async () => {
    await expect(asUser(ownerA, (q) => q("update public.organizations set status='active', plan_id=plan_id where id=$1", [blackBeard])))
      .rejects.toThrow(/permission denied/);
    await expect(asUser(ownerA, (q) => q("update public.organizations set limits='{\"barbers\":999}' where id=$1", [blackBeard])))
      .rejects.toThrow(/permission denied/);
  });

  it("owners cannot write module switches directly", async () => {
    await expect(asUser(ownerA, (q) => q(
      "insert into public.organization_features (organization_id, feature_id, override) select $1, id, 'grant' from public.features limit 1", [blackBeard])))
      .rejects.toThrow(/permission denied/);
  });

  it("self-service signup creates an organization with the caller as owner", async () => {
    const id = await asUser(stranger, async (q) => (await q("select public.create_organization('Nova Barbearia','nova-barbearia') as id"))[0].id);
    const m = await admin("select role from public.organization_members where organization_id=$1 and user_id=$2", [id, stranger]);
    expect(m[0].role).toBe("owner");
    const st = await admin("select status, trial_ends_at from public.organizations where id=$1", [id]);
    expect(st[0].status).toBe("trial");
    expect(st[0].trial_ends_at).not.toBeNull();
  });
});

describe("tenant isolation (RLS)", () => {
  it("each owner sees only their own organization and rows", async () => {
    const orgs = await asUser(ownerA, (q) => q("select id from public.organizations"));
    expect(orgs.map((o) => o.id)).toEqual([blackBeard]);
    expect((await asUser(ownerA, (q) => q("select name from public.customers"))).map((r) => r.name)).toEqual(["Cliente BB"]);
    expect((await asUser(ownerB, (q) => q("select name from public.customers"))).map((r) => r.name)).toEqual(["Cliente DC"]);
  });

  it("cannot read another organization's rows by id", async () => {
    expect(await asUser(ownerA, (q) => q("select * from public.services where organization_id=$1", [domCorte]))).toHaveLength(0);
    expect(await asUser(ownerA, (q) => q("select * from public.organization_members where organization_id=$1", [domCorte]))).toHaveLength(0);
  });

  it("cannot insert into another organization (spoofed organization_id)", async () => {
    await expect(asUser(ownerA, (q) => q(
      "insert into public.customers (organization_id,name,phone,phone_normalized) values ($1,'X','1','11911111111')", [domCorte])))
      .rejects.toThrow(/row-level security/);
  });

  it("cannot update or delete another organization's rows (silently affects zero rows)", async () => {
    await asUser(ownerA, (q) => q("update public.services set price_cents=1 where organization_id=$1", [domCorte]));
    await asUser(ownerA, (q) => q("delete from public.customers where organization_id=$1", [domCorte]));
    expect((await admin("select price_cents from public.services where organization_id=$1", [domCorte]))[0].price_cents).toBe(4500);
    expect(await admin("select 1 from public.customers where organization_id=$1", [domCorte])).toHaveLength(1);
  });

  it("cannot move a row into another organization via update", async () => {
    await expect(asUser(ownerA, (q) => q("update public.services set organization_id=$1 where organization_id=$2", [domCorte, blackBeard])))
      .rejects.toThrow(/row-level security/);
  });

  it("cannot add themselves as a member of another organization", async () => {
    await expect(asUser(ownerA, (q) => q("insert into public.organization_members (organization_id,user_id,role) values ($1,$2,'owner')", [domCorte, ownerA])))
      .rejects.toThrow(/row-level security/);
  });

  it("a user with no membership sees nothing", async () => {
    expect(await asUser(stranger, (q) => q("select * from public.customers"))).toHaveLength(0);
    expect(await asUser(stranger, (q) => q("select * from public.services"))).toHaveLength(0);
  });

  it("cannot read the other tenant's profiles, audit logs or subscriptions", async () => {
    expect(await asUser(ownerA, (q) => q("select id from public.profiles where id=$1", [ownerB]))).toHaveLength(0);
    expect(await asUser(ownerA, (q) => q("select * from public.admin_audit_logs"))).toHaveLength(0);
  });
});

describe("roles", () => {
  it("manager can create services; barber cannot but can read them", async () => {
    await asUser(managerA, (q) => q("insert into public.services (organization_id,name,price_cents,duration_minutes) values ($1,'Barba',3000,20)", [blackBeard]));
    await expect(asUser(barberA, (q) => q("insert into public.services (organization_id,name,price_cents,duration_minutes) values ($1,'Hack',1,20)", [blackBeard])))
      .rejects.toThrow(/row-level security/);
    expect((await asUser(barberA, (q) => q("select name from public.services order by name"))).length).toBeGreaterThanOrEqual(2);
  });

  it("barber can register customers but not delete them", async () => {
    await asUser(barberA, (q) => q("insert into public.customers (organization_id,name,phone,phone_normalized) values ($1,'Novo','2','11922222222')", [blackBeard]));
    await asUser(barberA, (q) => q("delete from public.customers where phone_normalized='11922222222'"));
    expect(await admin("select 1 from public.customers where phone_normalized='11922222222'")).toHaveLength(1);
  });

  it("only owners manage members; managers and barbers cannot", async () => {
    const newcomer = await createUser("newcomer@test");
    await expect(asUser(managerA, (q) => q("insert into public.organization_members (organization_id,user_id,role) values ($1,$2,'manager')", [blackBeard, newcomer])))
      .rejects.toThrow(/row-level security/);
    await asUser(ownerA, (q) => q("insert into public.organization_members (organization_id,user_id,role) values ($1,$2,'barber')", [blackBeard, newcomer]));
  });

  it("a barber cannot promote themselves", async () => {
    await asUser(barberA, (q) => q("update public.organization_members set role='owner' where user_id=$1", [barberA]));
    expect((await admin("select role from public.organization_members where user_id=$1", [barberA]))[0].role).toBe("barber");
  });

  it("the last owner cannot be removed or demoted", async () => {
    await expect(asUser(ownerB, (q) => q("update public.organization_members set role='manager' where user_id=$1", [ownerB]))).rejects.toThrow(/at least one active owner/);
    await expect(asUser(ownerB, (q) => q("delete from public.organization_members where user_id=$1", [ownerB]))).rejects.toThrow(/at least one active owner/);
  });
});

describe("individual module control (the Dom Corte scenario)", () => {
  it("starts with the module available to both shops", async () => {
    expect(await asUser(ownerA, (q) => q("select * from public.subscription_plans"))).toHaveLength(1);
    expect(await asUser(ownerB, (q) => q("select * from public.subscription_plans"))).toHaveLength(1);
    const menu = await asUser(ownerB, (q) => q("select public.my_enabled_features($1) as f", [domCorte]));
    expect(menu[0].f).toContain("customer_plans");
  });

  it("Master disables customer_plans for Dom Corte only", async () => {
    await asUser(master, (q) => q("select public.admin_set_org_feature($1,'customer_plans',false,'none','cliente não quer assinaturas')", [domCorte]));

    // 1. menu
    const menu = await asUser(ownerB, (q) => q("select public.my_enabled_features($1) as f", [domCorte]));
    expect(menu[0].f).not.toContain("customer_plans");
    expect(menu[0].f).toContain("services");
    // 2/3. data access and writes rejected by the database
    expect(await asUser(ownerB, (q) => q("select * from public.subscription_plans"))).toHaveLength(0);
    await expect(asUser(ownerB, (q) => q("insert into public.subscription_plans (organization_id,name,price_cents,uses_per_period) values ($1,'Novo',1000,2)", [domCorte])))
      .rejects.toThrow(/row-level security/);
    // 4. public site
    const pub = await asUser(null, (q) => q("select public.get_public_shop('dom-corte') as s"));
    expect(pub[0].s.plans).toEqual([]);
    expect(pub[0].s.services.length).toBe(1);
    // 5. Black Beard unaffected
    expect(await asUser(ownerA, (q) => q("select * from public.subscription_plans"))).toHaveLength(1);
    const pubBB = await asUser(null, (q) => q("select public.get_public_shop('black-beard') as s"));
    expect(pubBB[0].s.plans).toHaveLength(1);
    // 6. history preserved
    expect(await admin("select 1 from public.subscription_plans where organization_id=$1", [domCorte])).toHaveLength(1);
  });

  it("survives new sessions and can be re-enabled", async () => {
    expect(await asUser(ownerB, (q) => q("select * from public.subscription_plans"))).toHaveLength(0);
    await asUser(master, (q) => q("select public.admin_set_org_feature($1,'customer_plans',true,'none',null)", [domCorte]));
    expect(await asUser(ownerB, (q) => q("select * from public.subscription_plans"))).toHaveLength(1);
  });

  it("every change is audited with actor, old and new values", async () => {
    const logs = await admin(
      "select actor_id, action, entity_id, old_value, new_value, reason from public.admin_audit_logs where organization_id=$1 and entity='feature' order by id", [domCorte]);
    expect(logs).toHaveLength(2);
    expect(logs[0]).toMatchObject({ actor_id: master, action: "organization.feature", entity_id: "customer_plans", reason: "cliente não quer assinaturas" });
    expect(logs[0].old_value.effective).toBe(true);
    expect(logs[0].new_value).toMatchObject({ enabled: false, effective: false });
    expect(logs[1].new_value.effective).toBe(true);
  });

  it("the audit log is append-only and readable only by Master", async () => {
    await expect(admin("update public.admin_audit_logs set reason='tampered'")).rejects.toThrow(/append-only/);
    await expect(admin("delete from public.admin_audit_logs")).rejects.toThrow(/append-only/);
    expect((await asUser(master, (q) => q("select * from public.admin_audit_logs"))).length).toBeGreaterThan(0);
  });
});

describe("availability layers", () => {
  it("the plan decides by default; override grant/block and global switch refine it", async () => {
    const essencial = await planId("Essencial");
    await asUser(master, (q) => q("select public.admin_set_org_plan($1,$2,'downgrade')", [domCorte, essencial]));
    const feat = async (key: string) => (await admin("select private.feature_enabled($1,$2) as e", [domCorte, key]))[0].e;

    expect(await feat("agenda")).toBe(true);
    expect(await feat("finance")).toBe(false);                 // plan does not include it

    await asUser(master, (q) => q("select public.admin_set_org_feature($1,'finance',true,'grant','cortesia')", [domCorte]));
    expect(await feat("finance")).toBe(true);                  // explicit grant bypasses the plan

    await asUser(master, (q) => q("select public.admin_set_org_feature($1,'agenda',true,'block','inadimplência')", [domCorte]));
    expect(await feat("agenda")).toBe(false);                  // explicit block beats plan

    await asUser(master, (q) => q("select public.admin_set_feature_global('finance', false, 'manutenção')"));
    expect(await feat("finance")).toBe(false);                 // global switch beats grant
    await asUser(master, (q) => q("select public.admin_set_feature_global('finance', true, null)"));
    expect(await feat("finance")).toBe(true);

    const matrix = await asUser(master, (q) => q("select * from public.admin_org_feature_matrix($1)", [domCorte]));
    const row = matrix.find((r) => r.feature_key === "finance");
    expect(row).toMatchObject({ globally_enabled: true, plan_allows: false, override: "grant", effective: true });
    const premium = await planId("Premium");
    await asUser(master, (q) => q("select public.admin_set_org_plan($1,$2,'restore')", [domCorte, premium]));
  });

  it("an unknown module key is never enabled", async () => {
    expect((await admin("select private.feature_enabled($1,'nope') as e", [domCorte]))[0].e).toBe(false);
  });
});

describe("suspension", () => {
  it("requires a reason", async () => {
    await expect(asUser(master, (q) => q("select public.admin_set_org_status($1,'suspended','')", [domCorte]))).rejects.toThrow(/reason is required/);
  });

  it("blocks writes and the public page but keeps data readable; reactivation restores", async () => {
    await asUser(master, (q) => q("select public.admin_set_org_status($1,'suspended','pagamento em atraso')", [domCorte]));
    await expect(asUser(ownerB, (q) => q("insert into public.customers (organization_id,name,phone,phone_normalized) values ($1,'Z','3','11933333333')", [domCorte])))
      .rejects.toThrow(/row-level security/);
    expect(await asUser(ownerB, (q) => q("select * from public.customers"))).toHaveLength(1);     // still readable
    expect((await asUser(null, (q) => q("select public.get_public_shop('dom-corte') as s")))[0].s).toBeNull();

    await asUser(master, (q) => q("select public.admin_set_org_status($1,'active','regularizado')", [domCorte]));
    await asUser(ownerB, (q) => q("insert into public.customers (organization_id,name,phone,phone_normalized) values ($1,'Z','3','11933333333')", [domCorte]));
    expect((await admin("select suspended_at from public.organizations where id=$1", [domCorte]))[0].suspended_at).toBeNull();
  });

  it("an expired trial behaves like a suspension for writes", async () => {
    await asUser(master, (q) => q("select public.admin_set_org_status($1,'trial','teste')", [domCorte]));
    await asUser(master, (q) => q("select public.admin_set_org_trial($1, now() - interval '10 days', now() - interval '1 day', 'expirou')", [domCorte]));
    await expect(asUser(ownerB, (q) => q("insert into public.customers (organization_id,name,phone,phone_normalized) values ($1,'T','4','11944444444')", [domCorte])))
      .rejects.toThrow(/row-level security/);
    await asUser(master, (q) => q("select public.admin_set_org_status($1,'active',null)", [domCorte]));
  });

  it("Master can create an account manually for an existing user and it is audited", async () => {
    const owner = await createUser("novo.dono@test");
    const id = await asUser(master, async (q) => (await q("select public.admin_create_organization('Barbearia Nova','barbearia-nova',$1,'novo.dono@test',7) as id", [await planId("Profissional")]))[0].id);
    expect((await admin("select status from public.organizations where id=$1", [id]))[0].status).toBe("trial");
    expect(await asUser(owner, (q) => q("select id from public.organizations"))).toHaveLength(1);
    expect(await admin("select 1 from public.admin_audit_logs where action='organization.create' and organization_id=$1", [id])).toHaveLength(1);
  });
});
