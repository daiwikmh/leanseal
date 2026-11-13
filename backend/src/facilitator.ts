import { createNearFacilitator } from "@fastnear/x402/facilitator";
import { fromUnits } from "shared";
import { config } from "./config.js";
import { db } from "./db.js";
import { emit } from "./developer.js";

type Facilitator = ReturnType<typeof createNearFacilitator>;
type Payload = Parameters<Facilitator["verify"]>[0];
type Requirements = Parameters<Facilitator["verify"]>[1];
export type FacilitatorRequest = { x402Version?: number; paymentPayload: Payload; paymentRequirements: Requirements };

export const network = "near:mainnet";
export const minimumUnits = 10_000n;
export const hourlySettlements = 600;

let instance: Facilitator | null = null;

function facilitator(): Facilitator {
  instance ??= createNearFacilitator({
    registrations: [
      {
        network,
        signer: {
          relayers: [{ accountId: config.parent, secretKey: config.relayerKey() as `ed25519:${string}` }],
          rpcUrls: { [network]: config.rpcUrl },
        },
      },
    ],
  });
  return instance;
}

function fail(statusCode: number, message: string): never {
  throw Object.assign(new Error(message), { statusCode });
}

export function refuseRequirements(company: string, body: FacilitatorRequest): string | null {
  const req = body?.paymentRequirements;
  if (!req || !body.paymentPayload) return "Send {paymentPayload, paymentRequirements}.";
  if (req.scheme !== "exact" || req.network !== network) return `opencash settles the exact scheme on ${network} only.`;
  if (req.asset !== config.usdc) return "opencash settles USDC on NEAR only.";
  if (req.payTo !== company) return `payTo must be your opencash account ${company}.`;
  if (!/^\d+$/.test(String(req.amount)) || BigInt(req.amount) < minimumUnits) return `The minimum x402 price is ${fromUnits(minimumUnits.toString())} USDC.`;
  return null;
}

export function supported() {
  return facilitator().getSupported();
}

export async function verify(company: string, body: FacilitatorRequest) {
  const refused = refuseRequirements(company, body);
  if (refused) return { isValid: false, invalidReason: "opencash_policy", invalidMessage: refused };
  return facilitator().verify(body.paymentPayload, body.paymentRequirements);
}

export async function settle(company: string, body: FacilitatorRequest) {
  const refused = refuseRequirements(company, body);
  if (refused) return { success: false, errorReason: "opencash_policy", errorMessage: refused, transaction: "", network };
  const { rows } = await db().query<{ n: number }>(
    "select count(*)::int as n from x402_settlements where company = $1 and created_at > now() - interval '1 hour'",
    [company],
  );
  if (rows[0].n >= hourlySettlements) fail(429, `opencash sponsors up to ${hourlySettlements} x402 settlements per hour per business.`);
  const result = await facilitator().settle(body.paymentPayload, body.paymentRequirements);
  if (result.success && result.transaction) {
    const resource = body.paymentPayload.resource?.url ?? null;
    const payer = result.payer ?? "unknown";
    await db().query(
      "insert into x402_settlements (company, payer, amount_units, transaction, resource) values ($1, $2, $3, $4, $5) on conflict (transaction) do nothing",
      [company, payer, body.paymentRequirements.amount, result.transaction, resource],
    );
    await emit(company, "x402.paid", { payer, amount: fromUnits(body.paymentRequirements.amount), resource, tx_hash: result.transaction }).catch(() => undefined);
  }
  return result;
}

export async function listSettlements(company: string) {
  const { rows } = await db().query(
    "select payer, amount_units::text, transaction, resource, created_at from x402_settlements where company = $1 order by created_at desc limit 100",
    [company],
  );
  return rows.map((r) => ({ ...r, amount: fromUnits(r.amount_units), created_at: (r.created_at as Date).toISOString() }));
}
