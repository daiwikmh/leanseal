import { bytesToHex } from "viem";
import type { Hex } from "viem";
import { checkOpenedTx, openWithKey, unwrapBuilderKey } from "../../sealing-kit/src/envelope.js";
import type { Envelope } from "../../sealing-kit/src/envelope.js";
import type { Sidecar } from "./chain.js";
import { factsOf } from "./facts.js";

export interface NodeApi {
  pendingFor(builderId: string): Promise<{ id: Hex; env: Envelope }[]>;
  builderSubmitted(id: Hex, builderId: string, txHash: Hex): Promise<unknown>;
  reportJunk(id: Hex, builderId: string, keyHex: Hex): Promise<unknown>;
}

export type BuilderOutcome = { id: Hex; outcome: "submitted" | "junk-reported" | "skipped" | "failed"; detail?: string };

export class Builder {
  private readonly seen = new Set<Hex>();

  constructor(
    readonly builderId: string,
    private readonly secretKey: Uint8Array,
    private readonly node: NodeApi,
    private readonly sidecar: Sidecar,
  ) {}

  async poll(): Promise<BuilderOutcome[]> {
    const out: BuilderOutcome[] = [];
    for (const { id, env } of await this.node.pendingFor(this.builderId)) {
      if (this.seen.has(id)) continue;
      this.seen.add(id);
      out.push(await this.handle(id, env));
    }
    return out;
  }

  private async handle(id: Hex, env: Envelope): Promise<BuilderOutcome> {
    let key: Uint8Array;
    try {
      key = unwrapBuilderKey(env, this.builderId, this.secretKey);
    } catch (e) {
      return { id, outcome: "skipped", detail: (e as Error).message };
    }
    let facts: ReturnType<typeof factsOf>;
    try {
      facts = factsOf(openWithKey(env, key));
      checkOpenedTx(env, facts);
    } catch (e) {
      await this.node.reportJunk(id, this.builderId, bytesToHex(key));
      return { id, outcome: "junk-reported", detail: (e as Error).message };
    }
    try {
      const hash = await this.sidecar.submit(facts.tx);
      await this.sidecar.relayNow();
      await this.node.builderSubmitted(id, this.builderId, hash);
      return { id, outcome: "submitted", detail: hash };
    } catch (e) {
      return { id, outcome: "failed", detail: (e as Error).message };
    }
  }
}
