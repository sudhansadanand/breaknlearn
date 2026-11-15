/** In-memory stand-in for the Supabase GoTrue admin API used by scripts/ops/bootstrap-owner.mjs. */
import { randomUUID } from "node:crypto";

export interface FakeAuthUser {
  id: string;
  email: string;
  password: string;
  email_confirmed: boolean;
  app_metadata: Record<string, unknown>;
  last_sign_in_at: string | null;
}

export interface FakeGoTrue {
  users: FakeAuthUser[];
  requests: { method: string; path: string; auth: string | null; body: string }[];
  fetch: (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<Response>;
}

export function fakeGoTrue(base: string, serviceKey: string): FakeGoTrue {
  const users: FakeAuthUser[] = [];
  const requests: FakeGoTrue["requests"] = [];
  const view = (u: FakeAuthUser) => ({ id: u.id, email: u.email, app_metadata: u.app_metadata, last_sign_in_at: u.last_sign_in_at });
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetch: FakeGoTrue["fetch"] = async (url, init = {}) => {
    const method = init.method ?? "GET";
    const headers = init.headers ?? {};
    const u = new URL(url);
    requests.push({ method, path: u.pathname + u.search, auth: headers.authorization ?? null, body: init.body ?? "" });
    if (!url.startsWith(`${base}/auth/v1/admin/`)) return json(404, {});
    if (headers.authorization !== `Bearer ${serviceKey}` || headers.apikey !== serviceKey) return json(401, {});
    const body = init.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    if (method === "GET" && u.pathname === "/auth/v1/admin/users") {
      const page = Number(u.searchParams.get("page") ?? 1);
      const per = Number(u.searchParams.get("per_page") ?? 50);
      return json(200, { users: users.slice((page - 1) * per, page * per).map(view), aud: "authenticated" });
    }
    if (method === "POST" && u.pathname === "/auth/v1/admin/users") {
      if (users.some((x) => x.email === body.email)) return json(422, { msg: "exists" });
      const user: FakeAuthUser = {
        id: randomUUID(),
        email: String(body.email),
        password: String(body.password),
        email_confirmed: body.email_confirm === true,
        app_metadata: { provider: "email", ...(body.app_metadata as object) },
        last_sign_in_at: null,
      };
      users.push(user);
      return json(200, view(user));
    }
    const m = /^\/auth\/v1\/admin\/users\/([0-9a-f-]{36})$/.exec(u.pathname);
    if (method === "PUT" && m) {
      const user = users.find((x) => x.id === m[1]);
      if (!user) return json(404, {});
      if (typeof body.password === "string") user.password = body.password;
      if (body.email_confirm === true) user.email_confirmed = true;
      if (body.app_metadata) user.app_metadata = { ...user.app_metadata, ...(body.app_metadata as object) };
      return json(200, view(user));
    }
    return json(404, {});
  };
  return { users, requests, fetch };
}
