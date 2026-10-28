import { execFileSync } from "node:child_process";
import path from "node:path";
import { Pool, type PoolClient } from "pg";

export const DB = process.env.TEST_DB ?? "barber_test";
export const pool = new Pool({
  host: "localhost", user: "postgres", password: process.env.PGPASSWORD ?? "postgres", database: DB,
});

export function resetDatabase() {
  execFileSync(path.join(__dirname, "apply.sh"), { env: { ...process.env, TEST_DB: DB }, stdio: "pipe" });
}

/** Superuser query (bypasses RLS) — used only for arrange/inspect steps. */
export const admin = <T = any>(sql: string, params: unknown[] = []) =>
  pool.query(sql, params).then((r) => r.rows as T[]);

export async function createUser(email: string, fullName = email.split("@")[0]) {
  const [u] = await admin<{ id: string }>(
    "insert into auth.users (email, raw_user_meta_data) values ($1, $2) returning id",
    [email, JSON.stringify({ full_name: fullName })],
  );
  return u.id;
}

/** Runs fn as the `authenticated` role with the given user's JWT subject, in one transaction. */
export async function asUser<T>(userId: string | null, fn: (q: Q) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query(userId ? "set local role authenticated" : "set local role anon");
    await c.query("select set_config('request.jwt.claim.sub', $1, true)", [userId ?? ""]);
    const out = await fn(makeQ(c));
    await c.query("commit");
    return out;
  } catch (e) {
    await c.query("rollback").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}
export type Q = <R = any>(sql: string, params?: unknown[]) => Promise<R[]>;
const makeQ = (c: PoolClient): Q => (sql, params = []) => c.query(sql, params).then((r) => r.rows);

export const planId = async (name: string) =>
  (await admin<{ id: string }>("select id from public.saas_plans where name = $1", [name]))[0].id;

export async function makeMaster(email = "master@saas.test") {
  const id = await createUser(email, "Master");
  await admin("insert into public.platform_admins (user_id, granted_by) values ($1, 'test')", [id]);
  return id;
}

export async function makeShop(ownerId: string, name: string, slug: string, plan = "Premium") {
  const [o] = await admin<{ id: string }>(
    `insert into public.organizations (name, slug, status, plan_id) values ($1,$2,'active',$3) returning id`,
    [name, slug, await planId(plan)],
  );
  await admin("insert into public.organization_members (organization_id, user_id, role) values ($1,$2,'owner')", [o.id, ownerId]);
  await admin("insert into public.organization_settings (organization_id) values ($1)", [o.id]);
  return o.id;
}

export async function addMember(org: string, user: string, role: "owner" | "manager" | "barber") {
  await admin("insert into public.organization_members (organization_id, user_id, role) values ($1,$2,$3)", [org, user, role]);
}
