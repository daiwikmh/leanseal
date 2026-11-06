import { quicknet } from "../../sealing-kit/src/drand.js";
import { httpSidecar, viemChain } from "./chain.js";
import { loadConfig } from "./config.js";
import { LeanSealNode } from "./node.js";
import { startServer } from "./server.js";

const cfg = loadConfig(process.argv[2] ?? "leanseal.config.json");
const node = new LeanSealNode(cfg, viemChain(cfg.ethrexUrl, cfg.stakingRegistry), quicknet(), httpSidecar(cfg.sidecarUrl, cfg.relayAfterSubmit));
startServer(node, cfg.port);
console.log(`leanseal node on http://127.0.0.1:${cfg.port} with builders ${Object.keys(cfg.builders).join(", ")}`);
setInterval(() => node.tick().catch((e) => console.error("tick:", (e as Error).message)), cfg.tickMs);
