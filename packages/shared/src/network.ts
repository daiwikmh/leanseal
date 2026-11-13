export const network = {
  id: "mainnet",
  rpc: "https://rpc.mainnet.near.org",
  explorer: "https://nearblocks.io",
  parent: "opencash.near",
  contract: "registry.opencash.near",
  usdc: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
} as const;

export const usdcAssetId = `nep141:${network.usdc}`;

export function txUrl(hash: string): string {
  return `${network.explorer}/txns/${hash}`;
}

export function accountUrl(account: string): string {
  return `${network.explorer}/address/${account}`;
}
