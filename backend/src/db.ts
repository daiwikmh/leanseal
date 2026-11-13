import pg from "pg";
import { config } from "./config.js";

let shared: pg.Pool | null = null;

export function db(): pg.Pool {
  shared ??= new pg.Pool({ connectionString: config.databaseUrl(), max: 5 });
  return shared;
}
