import { assertBindings } from "./sql";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import worker from "../src/index";
import { type Env, hash } from "../src/runtime";
export function harness() {
  const db = new DatabaseSync(":memory:");
  for (const file of readdirSync(new URL("../migrations/", import.meta.url))
    .filter((f) => f.endsWith(".sql"))
    .sort())
    db.exec(
      readFileSync(new URL("../migrations/" + file, import.meta.url), "utf8"),
    );
  const statement = (sql: string, params: any[] = []): any => ({
    bind: (...p: any[]) => statement(sql, p),
    first: async () => {
      assertBindings(sql, params);
      return db.prepare(sql).get(...params) || null;
    },
    all: async () => {
      assertBindings(sql, params);
      return { results: db.prepare(sql).all(...params) };
    },
    run: async () => {
      assertBindings(sql, params);
      const r = db.prepare(sql).run(...params);
      return { meta: { changes: Number(r.changes) } };
    },
    _sql: sql,
    _params: params,
  });
  const bytes = new Map<string, ArrayBuffer>();
  const flags = {
    visible: true,
    failPut: false,
    failDelete: false,
    reads: 0,
    writes: 0,
    deletes: 0,
  };
  const env: Env = {
    APP_ORIGIN: "https://unit-test.vercel.app",
    DB: {
      prepare: statement,
      batch: async (stmts: any[]) => {
        db.exec("BEGIN");
        try {
          const results = stmts.map((s) => ({
            meta: {
              changes: Number(db.prepare(s._sql).run(...s._params).changes),
            },
          }));
          db.exec("COMMIT");
          return results;
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      },
    } as any,
    DOCUMENTS_KV: {
      put: async (key: string, value: ArrayBuffer) => {
        flags.writes++;
        bytes.set(key, value);
        if (flags.failPut) throw new Error("ambiguous put");
      },
      get: async (key: string) => {
        flags.reads++;
        return flags.visible ? bytes.get(key) || null : null;
      },
      delete: async (key: string) => {
        flags.deletes++;
        if (flags.failDelete) throw new Error("delete unavailable");
        bytes.delete(key);
      },
    } as any,
  };
  const request = (
    path: string,
    method = "GET",
    data?: unknown,
    session = "",
    origin: string | null = env.APP_ORIGIN,
  ) => {
    const headers = new Headers(session ? { Cookie: session } : {});
    if (origin !== null) headers.set("Origin", origin);
    if (data && !(data instanceof FormData))
      headers.set("Content-Type", "application/json");
    return worker.fetch(
      new Request("https://api.test/api" + path, {
        method,
        headers,
        body:
          data instanceof FormData
            ? data
            : data
              ? JSON.stringify(data)
              : undefined,
      }),
      env,
    );
  };
  const user = async (email = "student@example.com") => {
    const id = crypto.randomUUID(),
      raw = crypto.randomUUID(),
      session = "session=" + raw;
    db.prepare("INSERT INTO users(id,email,password) VALUES(?,?,?)").run(
      id,
      email,
      "synthetic-test-hash",
    );
    db.prepare("INSERT INTO profiles(user_id) VALUES(?)").run(id);
    db.prepare(
      "INSERT INTO sessions(token,user_id,expires_at) VALUES(?,?,?)",
    ).run(await hash(raw), id, Date.now() + 3600000);
    return { id, session };
  };
  return { db, env, flags, bytes, request, user };
}
export function fileForm(
  content: string | Uint8Array = "private CV",
  name = "cv.txt",
  type = "text/plain",
) {
  const form = new FormData();
  form.set("file", new File([content], name, { type }));
  return form;
}
