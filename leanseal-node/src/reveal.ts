import { encodeAbiParameters, keccak256, stringToHex } from "viem";
import type { Address, Hex } from "viem";
import { latestRound } from "../../sealing-kit/src/drand.js";
import type { ChainClient } from "../../sealing-kit/src/drand.js";
import { timelockOpen, timelockSeal } from "../../sealing-kit/src/envelope.js";

/** A sealed order's reveal parameters, locked to a drand round and gossiped. */
export interface RevealTicket {
  version: 1;
  kind: "batch-reveal";
  chainId: number;
  hook: Address;
  user: Address;
  batchRound: string;
  commitment: Hex;
  round: number;
  lock: string;
}

export interface OrderPlaintext {
  zeroForOne: boolean;
  amountIn: string;
  minOut: string;
  salt: Hex;
}

export interface HookOrder {
  user: Address;
  commitment: Hex;
  revealed: boolean;
}

/** What the desk needs from the chain; viem-backed in production, faked in tests. */
export interface HookChain {
  currentRound(): Promise<bigint>;
  revealRounds: bigint;
  orders(batchRound: bigint): Promise<HookOrder[]>;
  reveal(batchRound: bigint, index: number, order: OrderPlaintext): Promise<Hex>;
  settleIfDue(): Promise<Hex | null>;
}

export type TicketStatus = "locked" | "revealed" | "junk" | "expired" | "failed";

export interface TicketEntry {
  id: Hex;
  ticket: RevealTicket;
  peer: string;
  status: TicketStatus;
  receivedAt: number;
  revealTx?: Hex;
  note?: string;
}

export class TicketError extends Error {
  constructor(readonly rule: string, message: string) {
    super(`${rule}: ${message}`);
  }
}

export interface DeskConfig {
  chainId: number;
  hook: Address;
  maxTicketBytes: number;
  maxRoundsAhead: number;
  peerTicketsPerMinute: number;
}

const HEX = /^0x[0-9a-fA-F]+$/;

export const REVEAL_RULES = [
  { id: "REV-010", name: "size", text: "Ticket is at most maxTicketBytes of JSON", rule: "size", re: /./ },
  { id: "REV-020", name: "shape", text: "Version 1, kind batch-reveal, this chain and this pool's hook, well-formed fields", rule: "shape", re: /./ },
  { id: "REV-030", name: "deadline", text: "The drand round opens between 1 and maxRoundsAhead rounds from now", rule: "round", re: /./ },
  { id: "REV-040", name: "committed", text: "The commitment is on chain in that batch, by this user, and not yet revealed", rule: "commit", re: /./ },
  { id: "REV-050", name: "duplicate", text: "No ticket for this commitment is already held", rule: "pool", re: /./ },
  { id: "REV-060", name: "rate", text: "The sending peer is under peerTicketsPerMinute", rule: "peer", re: /./ },
] as const;

export function commitmentOf(hook: Address, user: Address, batchRound: bigint, o: OrderPlaintext): Hex {
  return keccak256(encodeAbiParameters(
    [{ type: "address" }, { type: "address" }, { type: "uint256" }, { type: "bool" }, { type: "uint128" }, { type: "uint128" }, { type: "bytes32" }],
    [hook, user, batchRound, o.zeroForOne, BigInt(o.amountIn), BigInt(o.minOut), o.salt],
  ));
}

export const ticketId = (t: RevealTicket): Hex => keccak256(stringToHex(JSON.stringify([t.hook.toLowerCase(), t.batchRound, t.commitment.toLowerCase()])));

export async function lockTicket(
  base: Omit<RevealTicket, "lock" | "version" | "kind" | "commitment">,
  order: OrderPlaintext,
  drand: ChainClient,
): Promise<RevealTicket> {
  const lock = await timelockSeal(base.round, new TextEncoder().encode(JSON.stringify(order)), drand);
  return { version: 1, kind: "batch-reveal", ...base, commitment: commitmentOf(base.hook, base.user, BigInt(base.batchRound), order), lock };
}

export async function openTicket(t: RevealTicket, drand: ChainClient): Promise<OrderPlaintext> {
  return JSON.parse(new TextDecoder().decode(await timelockOpen(t.lock, drand))) as OrderPlaintext;
}

/** Holds reveal tickets until their drand round, then reveals the orders and settles batches. */
export class RevealDesk {
  readonly tickets = new Map<Hex, TicketEntry>();
  private readonly peerTimes = new Map<string, number[]>();

  constructor(
    private readonly cfg: DeskConfig,
    private readonly chain: HookChain,
    private readonly drand: ChainClient,
    private readonly now: () => number = Date.now,
    private readonly open: (t: RevealTicket, d: ChainClient) => Promise<OrderPlaintext> = openTicket,
  ) {}

  async admit(t: RevealTicket, peer: string): Promise<Hex> {
    if (JSON.stringify(t ?? null).length > this.cfg.maxTicketBytes) throw new TicketError("size", `ticket over ${this.cfg.maxTicketBytes} bytes`);
    if (!t || t.version !== 1 || t.kind !== "batch-reveal") throw new TicketError("shape", "not a version 1 batch-reveal ticket");
    if (t.chainId !== this.cfg.chainId) throw new TicketError("shape", `chainId ${t.chainId} != ${this.cfg.chainId}`);
    if (t.hook?.toLowerCase() !== this.cfg.hook.toLowerCase()) throw new TicketError("shape", "ticket is for another pool");
    if (![t.user, t.commitment].every((h) => typeof h === "string" && HEX.test(h)) || !/^\d+$/.test(t.batchRound) || typeof t.lock !== "string") {
      throw new TicketError("shape", "malformed field");
    }
    if (!Number.isInteger(t.round)) throw new TicketError("shape", "malformed round");
    const latest = await latestRound(this.drand);
    if (t.round <= latest || t.round > latest + this.cfg.maxRoundsAhead) throw new TicketError("round", `round ${t.round} not within 1..${this.cfg.maxRoundsAhead} of ${latest}`);
    const order = (await this.chain.orders(BigInt(t.batchRound))).find((o) => o.commitment.toLowerCase() === t.commitment.toLowerCase());
    if (!order || order.user.toLowerCase() !== t.user.toLowerCase()) throw new TicketError("commit", "no such commitment by this user in that batch");
    if (order.revealed) throw new TicketError("commit", "order already revealed");
    const id = ticketId(t);
    if (this.tickets.has(id)) throw new TicketError("pool", "duplicate ticket");
    const time = this.now();
    const recent = (this.peerTimes.get(peer) ?? []).filter((x) => time - x < 60_000);
    if (recent.length >= this.cfg.peerTicketsPerMinute) throw new TicketError("peer", "rate limit");
    recent.push(time);
    this.peerTimes.set(peer, recent);
    this.tickets.set(id, { id, ticket: t, peer, status: "locked", receivedAt: time });
    return id;
  }

  status(id: Hex): Omit<TicketEntry, "ticket"> & { batchRound: string; round: number; user: Address } {
    const e = this.tickets.get(id);
    if (!e) throw new TicketError("unknown", `no ticket ${id}`);
    const { ticket, ...rest } = e;
    return { ...rest, batchRound: ticket.batchRound, round: ticket.round, user: ticket.user };
  }

  async tick(): Promise<void> {
    const locked = [...this.tickets.values()].filter((e) => e.status === "locked");
    if (locked.length) {
      const latest = await latestRound(this.drand);
      for (const e of locked.filter((x) => x.ticket.round <= latest)) await this.release(e);
    }
    await this.chain.settleIfDue().catch(() => null);
  }

  private async release(e: TicketEntry): Promise<void> {
    const t = e.ticket;
    let order: OrderPlaintext;
    try {
      order = await this.open(t, this.drand);
    } catch (err) {
      const message = (err as Error).message;
      if (/fetch|connect|network|timed? ?out|ECONN|ENOTFOUND|socket/i.test(message)) {
        e.note = `drand unreachable, retrying: ${message}`.slice(0, 300);
        return;
      }
      Object.assign(e, { status: "junk", note: `cannot open: ${message}`.slice(0, 300) });
      return;
    }
    const batchRound = BigInt(t.batchRound);
    if (commitmentOf(t.hook, t.user, batchRound, order).toLowerCase() !== t.commitment.toLowerCase()) {
      Object.assign(e, { status: "junk", note: "opened order does not match the commitment" });
      return;
    }
    const orders = await this.chain.orders(batchRound);
    const index = orders.findIndex((o) => o.commitment.toLowerCase() === t.commitment.toLowerCase());
    if (index >= 0 && orders[index].revealed) {
      Object.assign(e, { status: "revealed", note: "already revealed (by a peer or the user)" });
      return;
    }
    const cur = await this.chain.currentRound();
    if (cur <= batchRound) return;
    if (cur > batchRound + this.chain.revealRounds) {
      Object.assign(e, { status: "expired", note: `reveal window closed at batch round ${batchRound + this.chain.revealRounds}` });
      return;
    }
    try {
      e.revealTx = await this.chain.reveal(batchRound, index, order);
      e.status = "revealed";
    } catch (err) {
      const now = await this.chain.orders(batchRound).catch(() => []);
      if (now[index]?.revealed) Object.assign(e, { status: "revealed", note: "a peer revealed it first" });
      else Object.assign(e, { status: "failed", note: (err as Error).message.slice(0, 300) });
    }
  }
}
