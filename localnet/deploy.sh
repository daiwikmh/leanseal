#!/usr/bin/env bash
# Deploy registry, Uniswap, tUSD pool and PQ wallet on the local chain.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RPC=http://127.0.0.1:8545
JOURNAL="$ROOT/sidecar/deploy/predeploy/addresses/1337.json"

ROUTER=$(python3 -c "import json;print(json.load(open('$ROOT/localnet/uni.local.json')).get('UNIVERSAL_ROUTER',''))" 2>/dev/null || true)
if [ -n "$ROUTER" ] && [ "$(cast codesize "$ROUTER" --rpc-url $RPC 2>/dev/null || echo 0)" -gt 0 ]; then
  echo "predeploys already on chain, skipping replay"
else
cp "$JOURNAL" "$ROOT/localnet/public-devnet-addresses.1337.json.bak"
(
  cd "$ROOT/sidecar"
  PREDEPLOY_RPC_URL=$RPC PREDEPLOY_DEPLOYER_KEY="$(python3 -c "import json;print(json.load(open('$ROOT/workshop/.workshop-state.json'))['participantKey'])")" \
    bun run predeploy run staking-registry weth9 permit2 uniswap-v4 uniswap-v4-periphery | grep -E "deployed|->" || true
)
python3 - "$JOURNAL" "$ROOT/localnet/uni.local.json" <<'EOF'
import json, sys
d = json.load(open(sys.argv[1]))["protocols"]
flat = {k: v for p in d.values() for k, v in (p.get("contracts") or {}).items()}
keep = ["WETH9", "PERMIT2", "POOL_MANAGER", "POSITION_MANAGER", "STATE_VIEW", "QUOTER", "UNIVERSAL_ROUTER", "StakingRegistry"]
json.dump({"rpc": "http://127.0.0.1:8545", "chainId": 1337, **{k: flat[k] for k in keep}}, open(sys.argv[2], "w"), indent=2)
EOF
cp "$ROOT/localnet/public-devnet-addresses.1337.json.bak" "$JOURNAL"
fi
REGISTRY=$(python3 -c "import json;print(json.load(open('$ROOT/localnet/uni.local.json'))['StakingRegistry'])")
sed -i '' -E "s#stakingRegistry: \"0x[0-9a-fA-F]+\"#stakingRegistry: \"$REGISTRY\"#" "$ROOT/workshop/workshop.config.local.json5"
python3 - "$ROOT" "$REGISTRY" <<'EOF'
import json, sys
root, reg = sys.argv[1], sys.argv[2]
for p, key in [(f"{root}/sidecar/config.local.json", "stakingRegistryAddress"), (f"{root}/leanseal-node/leanseal.config.json", "stakingRegistry")]:
    c = json.load(open(p)); c[key] = reg; json.dump(c, open(p, "w"), indent=2)
EOF

cd "$ROOT/workshop"
rm -f local.pq-state.json local.uni-state.json local.mev-state.json local.mev-result.json
export LEANSEAL_NET=local WORKSHOP_CONFIG="$PWD/workshop.config.local.json5" UNI_ADDRESSES="$ROOT/localnet/uni.local.json" ETHREX_URL=$RPC
npx tsx src/uni/setup_pool.ts | tail -1

until [ "$(cast block-number --rpc-url $RPC)" -ge 66 ]; do sleep 5; done
SPHINCS_OUT="${SPHINCS_OUT:?set SPHINCS_OUT to a Foundry out/ with the verifier, Yul module and LeanSealAccount}" \
PQ_SIGNER="$ROOT/signer/leanseal-signer" LEANSEAL_XMSS_CACHE="$ROOT/.secrets/xmss.cache" \
PQ_SEED_FILE="$ROOT/.secrets/pq.seed" PQ_PK_FILE="$ROOT/.secrets/pq.pk" PQ_SUBMIT_URL=http://127.0.0.1:14347/rpc VERIFY_GAS=200000 \
  npx tsx src/pq/pq_e2e.ts transfer | grep -E "deployed|account|ADMITTED"
curl -s -X POST http://127.0.0.1:14347/rpc -H 'content-type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"debug_bundler_sendBundleNow","params":[]}' >/dev/null
echo "deployed; PQ wallet: $(python3 -c "import json;print(json.load(open('local.pq-state.json'))['account'])")"
