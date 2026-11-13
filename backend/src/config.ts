import { network } from "shared";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env ${name}. Copy backend/.env.example to backend/.env.`);
  return value;
}

export const config = {
  port: Number(process.env.PORT ?? 8787),
  rpcUrl: process.env.RPC_URL ?? network.rpc,
  parent: process.env.PARENT_ACCOUNT ?? network.parent,
  contract: process.env.CONTRACT_ID ?? network.contract,
  usdc: network.usdc,
  operatorKey: () => required("OPERATOR_PRIVATE_KEY"),
  relayerKey: () => process.env.X402_RELAYER_PRIVATE_KEY || required("OPERATOR_PRIVATE_KEY"),
  nearAiKey: () => required("NEAR_AI_API_KEY"),
  nearAiModel: process.env.NEAR_AI_MODEL ?? "Qwen/Qwen3.6-35B-A3B-FP8",
  oneClickJwt: process.env.ONECLICK_JWT,
  newAccountNear: process.env.NEW_ACCOUNT_NEAR ?? "0.01",
  watchMs: Number(process.env.WATCH_INTERVAL_MS ?? 20_000),
  databaseUrl: () => required("DATABASE_URL"),
  webUrl: (process.env.PUBLIC_WEB_URL ?? "http://localhost:4321").replace(/\/$/, ""),
  applicationKey: () => required("APPLICATION_KEY"),
};
