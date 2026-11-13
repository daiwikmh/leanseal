import type { Company, CompanyStatus, Jurisdiction } from "shared";
import { db } from "./db.js";
import { view } from "./near.js";

type ChainCompany = Pick<Company, "account_id" | "owner" | "legal_name" | "country" | "created_at_ms" | "updated_at_ms">;

export async function getBusiness(account: string): Promise<Company | null> {
  const chain = await view<ChainCompany | null>("get_company", { account_id: account });
  if (!chain) return null;
  return withFormation(chain);
}

export async function withFormation(chain: ChainCompany): Promise<Company> {
  const { rows } = await db()
    .query<{ legal_name: string; jurisdiction: Jurisdiction | null; status: CompanyStatus; application_hash: string | null; doc_hashes: string[] }>(
      "select legal_name, jurisdiction, status, application_hash, doc_hashes from formations where account_id = $1",
      [chain.account_id],
    )
    .catch(() => ({ rows: [] }));
  const f = rows[0];
  return {
    ...chain,
    legal_name: f?.legal_name ?? chain.legal_name,
    jurisdiction: f?.jurisdiction ?? null,
    status: f?.status ?? "draft",
    application_hash: f?.application_hash ?? null,
    doc_hashes: f?.doc_hashes ?? [],
  };
}

export async function recordFormation(account: string, legalName: string, jurisdiction: Jurisdiction, applicationHash: string) {
  await db().query(
    `insert into formations (account_id, legal_name, jurisdiction, application_hash) values ($1, $2, $3, $4)
     on conflict (account_id) do update set legal_name = excluded.legal_name, jurisdiction = excluded.jurisdiction,
       application_hash = excluded.application_hash, updated_at = now()`,
    [account, legalName, jurisdiction, applicationHash],
  );
}
