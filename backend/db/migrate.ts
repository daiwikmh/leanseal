import { readdir, readFile } from "node:fs/promises";
import { db } from "../src/db.js";

const dir = new URL("./", import.meta.url);
await db().query("create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())");
const applied = new Set((await db().query<{ name: string }>("select name from schema_migrations")).rows.map((r) => r.name));
for (const name of (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort()) {
  if (applied.has(name)) continue;
  const client = await db().connect();
  try {
    await client.query("begin");
    await client.query(await readFile(new URL(name, dir), "utf8"));
    await client.query("insert into schema_migrations (name) values ($1)", [name]);
    await client.query("commit");
    console.log("applied", name);
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}
await db().end();
