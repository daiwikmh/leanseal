import { createServer } from "node:http";
import type { IncomingMessage, Server } from "node:http";
import type { Hex } from "viem";
import type { Envelope } from "../../sealing-kit/src/envelope.js";
import type { NodeApi } from "./builder.js";
import { AdmissionError } from "./node.js";
import type { LeanSealNode } from "./node.js";

type Handler = (params: any[], peer: string) => Promise<unknown> | unknown;

export function methods(node: LeanSealNode): Record<string, Handler> {
  return {
    leanseal_sendEnvelope: async ([env], peer) => ({ id: await node.admit(env as Envelope, peer) }),
    leanseal_envelopeStatus: ([id]) => node.status(id as Hex),
    leanseal_pendingFor: ([builderId]) => node.pendingFor(String(builderId)).map((e) => ({ id: e.id, env: e.env })),
    leanseal_builderSubmitted: ([id, builderId, txHash]) => node.status(node.builderSubmitted(id, builderId, txHash).id),
    leanseal_reportJunk: async ([id, builderId, keyHex]) => node.status((await node.reportJunk(id, builderId, keyHex)).id),
  };
}

const readBody = (req: IncomingMessage) =>
  new Promise<string>((resolve, reject) => {
    let data = "";
    req.on("data", (c) => { data += c; if (data.length > 1_000_000) req.destroy(); });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });

export function startServer(node: LeanSealNode, port: number, host = "127.0.0.1"): Server {
  const table = methods(node);
  const server = createServer(async (req, res) => {
    const peer = req.socket.remoteAddress ?? "unknown";
    let id: unknown = null;
    let reply: object;
    try {
      const body = JSON.parse(await readBody(req));
      id = body.id ?? null;
      const fn = table[body.method];
      if (!fn) throw new AdmissionError("rpc", `unknown method ${body.method}`);
      reply = { jsonrpc: "2.0", id, result: await fn(body.params ?? [], peer) };
    } catch (e) {
      const rule = e instanceof AdmissionError ? e.rule : "internal";
      reply = { jsonrpc: "2.0", id, error: { code: -32000, message: (e as Error).message, data: { rule } } };
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(reply, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
  });
  server.listen(port, host);
  return server;
}

export function httpNodeApi(url: string): NodeApi {
  const call = async (method: string, params: unknown[]) => {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    const body = await res.json();
    if (body.error) throw new Error(body.error.message);
    return body.result;
  };
  return {
    pendingFor: (builderId) => call("leanseal_pendingFor", [builderId]),
    builderSubmitted: (id, builderId, txHash) => call("leanseal_builderSubmitted", [id, builderId, txHash]),
    reportJunk: (id, builderId, keyHex) => call("leanseal_reportJunk", [id, builderId, keyHex]),
  };
}
