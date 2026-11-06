import { bytesToHex, hexToBytes } from "viem";
import type { Address, Hex } from "viem";
import { getProfile } from "@forshtat/hegota-support/profiles";
import * as lib from "@forshtat/hegota-support/tx";
import type { TxFacts } from "../../sealing-kit/src/envelope.js";

export const profile = getProfile("ethrex-eip8141-tracer");

const INTRINSIC = 12_000n;
const PER_FRAME = 475n;
const PER_BYTE_FLOOR = 64n;

export function decodeRaw(raw: Uint8Array): lib.FrameTx {
  return lib.decodeTx(profile, bytesToHex(raw));
}

export function maxCostBound(tx: lib.FrameTx, rawLength: number): bigint {
  const limits = tx.frames.reduce((sum, f) => sum + f.limits.execution + f.limits.state, 0n);
  const gas = limits + INTRINSIC + PER_FRAME * BigInt(tx.frames.length) + PER_BYTE_FLOOR * BigInt(rawLength);
  const value = tx.frames.reduce((sum, f) => sum + f.value, 0n);
  return tx.fees.maxFeePerGas * gas + value;
}

export function factsOf(raw: Uint8Array): TxFacts & { tx: lib.FrameTx } {
  const tx = decodeRaw(raw);
  if (tx.nonceKeys.length !== 1) throw new Error("only single nonce key txs are supported");
  return {
    tx,
    chainId: Number(tx.chainId),
    sender: tx.sender.toLowerCase() as Address,
    nonceKey: tx.nonceKeys[0],
    nonceSeq: tx.nonceSeq,
    maxCost: maxCostBound(tx, raw.length),
  };
}

export const rawHex = (raw: Uint8Array): Hex => bytesToHex(raw);
export const rawBytes = (hex: Hex): Uint8Array => hexToBytes(hex);
