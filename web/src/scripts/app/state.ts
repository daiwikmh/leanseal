import type { Advice } from "../lib/api";
import type { PasskeySession } from "../lib/passkey";
import type { Company, Invoice } from "shared";

export const state: {
  session: PasskeySession | null;
  company: Company | null;
  invoices: Invoice[];
  advice: Advice | null;
  preview: string | null;
} = { session: null, company: null, invoices: [], advice: null, preview: null };
