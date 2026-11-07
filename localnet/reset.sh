#!/usr/bin/env bash
# Fresh local EIP-8141 chain (ethrex + Lighthouse).
set -euo pipefail
cd "$(dirname "$0")"
P=leanseal-localnet

docker compose -p "$P" down --remove-orphans 2>/dev/null || true
rm -rf data
export LIGHTHOUSE_BEACON_1_IP=pending LIGHTHOUSE_BEACON_1_ENR=pending
export GENESIS_TIMESTAMP=$(date +%s)
echo "$GENESIS_TIMESTAMP" > genesis_timestamp.txt
docker compose -p "$P" up genesis validator-keys
docker compose -p "$P" up -d --no-deps ethrex

SUBNET=$(docker network inspect "${P}_default" -f '{{range .IPAM.Config}}{{.Subnet}}{{end}}')
export LIGHTHOUSE_BEACON_1_IP="$(echo "$SUBNET" | sed -E 's#^([0-9]+\.[0-9]+\.[0-9]+)\..*#\1#').3"
docker compose -p "$P" up -d --no-deps lighthouse-beacon

for _ in $(seq 1 40); do
  ENR=$(curl -s -m 3 http://127.0.0.1:5052/eth/v1/node/identity | python3 -c "import json,sys;print(json.load(sys.stdin)['data']['enr'])" 2>/dev/null || true)
  [ -n "$ENR" ] && break
  sleep 3
done
[ -n "$ENR" ] || { echo "beacon 1 ENR not available"; exit 1; }
echo "$ENR" > beacon1.enr
export LIGHTHOUSE_BEACON_1_ENR="$ENR"
docker compose -p "$P" up -d --no-deps lighthouse-beacon-2 lighthouse-validator

until [ "$(cast block-number --rpc-url http://127.0.0.1:8545 2>/dev/null || echo 0)" -ge 2 ]; do sleep 5; done
echo "local chain producing blocks; frame txs from block ~64"
