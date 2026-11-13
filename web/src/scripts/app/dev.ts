import { nearKeyFromPrf, network, type Company } from "shared";
import { api } from "../lib/api";
import type { PasskeySession } from "../lib/passkey";

export const devEnabled = import.meta.env.DEV;

const handle = "dev";

export function devSession(): PasskeySession {
  return { accountId: `${handle}.${network.parent}`, key: nearKeyFromPrf(new Uint8Array(32).fill(1)) };
}

export async function devCompany(session: PasskeySession): Promise<Company> {
  try {
    return await api.company(session.accountId);
  } catch (error) {
    if (!String(error).includes("No company is registered")) throw error;
    const { company } = await api.createCompany({
      handle,
      legalName: "opencash Dev Studio",
      country: "India",
      publicKey: session.key.publicKey,
    });
    return company;
  }
}

export function undeployedCompany(session: PasskeySession): Company {
  return {
    account_id: session.accountId,
    owner: session.accountId,
    legal_name: "Not on NEAR yet",
    jurisdiction: null,
    country: "—",
    status: "draft",
    created_at_ms: Date.now(),
    updated_at_ms: Date.now(),
    doc_hashes: [],
    application_hash: null,
  };
}
