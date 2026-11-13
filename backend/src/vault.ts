import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { config } from "./config.js";

export type Sealed = { ciphertext: Buffer; iv: Buffer; authTag: Buffer; keyVersion: number };

function key(): Buffer {
  const raw = Buffer.from(config.applicationKey(), "base64");
  if (raw.length !== 32) throw new Error("APPLICATION_KEY must be 32 bytes, base64-encoded.");
  return raw;
}

export function seal(plaintext: string, boundTo: string): Sealed {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  cipher.setAAD(Buffer.from(boundTo));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return { ciphertext, iv, authTag: cipher.getAuthTag(), keyVersion: 1 };
}

export function open(sealed: Sealed, boundTo: string): string {
  const decipher = createDecipheriv("aes-256-gcm", key(), sealed.iv);
  decipher.setAAD(Buffer.from(boundTo));
  decipher.setAuthTag(sealed.authTag);
  return Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]).toString("utf8");
}
