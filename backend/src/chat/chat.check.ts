import assert from "node:assert/strict";
import { db } from "../db.js";
import { eventMessage, helpText, parseCommand } from "./core.js";
import { createLinkCode, dispatchOutbox, linkedAccount, notifyAccount, redeemLinkCode } from "./outbox.js";
import { telegram } from "./telegram.js";

assert.deepEqual(parseCommand("pay Ada 50 USDC on base to 0xabc"), { kind: "pay", name: "Ada", amount: "50", token: "USDC", chain: "base", address: "0xabc" });
assert.deepEqual(parseCommand("send Bo Chen $12.50 sol on solana to 7xKX"), { kind: "pay", name: "Bo Chen", amount: "12.50", token: "SOL", chain: "sol", address: "7xKX" });
assert.deepEqual(parseCommand("pay Ada 50"), { kind: "pay", name: "Ada", amount: "50", token: null, chain: null, address: null });
assert.deepEqual(parseCommand("pay Ada 20 usdt on arbitrum to 0x1"), { kind: "pay", name: "Ada", amount: "20", token: "USDT", chain: "arb", address: "0x1" });
assert.deepEqual(parseCommand("request 120 from Northwind for design work"), { kind: "request", amount: "120", from: "Northwind", description: "design work" });
assert.deepEqual(parseCommand("invoice $5 from Globex"), { kind: "request", amount: "5", from: "Globex", description: null });
assert.deepEqual(parseCommand("pay alice.near 50"), { kind: "pay", name: "alice.near", amount: "50", token: "USDC", chain: "near", address: "alice.near" }, "a NEAR name pays that account directly");
assert.deepEqual(parseCommand("send bob.opencash.near 5 wnear"), { kind: "pay", name: "bob.opencash.near", amount: "5", token: "WNEAR", chain: "near", address: "bob.opencash.near" });
assert.equal(parseCommand("/start").kind, "help");
assert.equal(parseCommand("/link@opencash_bot").kind, "link");
assert.equal(parseCommand("Balance").kind, "balance");
assert.equal(parseCommand("pay Ada fifty").kind, "unknown");
assert.equal(parseCommand("pay Ada 1.234 USDC on base to 0x1").kind, "unknown", "more than two decimals is refused");

assert.match(eventMessage("invoice.paid", { id: "acme-3", client_name: "Northwind", amount: "1250500000" })!, /\$1,250\.50 USDC received/);
assert.match(eventMessage("payout.completed", { payee_name: "Ada", amount_out: "49.9", symbol: "USDC", chain: "base" })!, /Ada received 49\.9 USDC on base/);
assert.equal(eventMessage("test.ping", {}), null);

const account = `chat-check-${Date.now()}.opencash.near`;
const user = `tg-${Date.now()}`;
const code = await createLinkCode("telegram", user, "@ada");
assert.match(code, /^[a-z0-9]{12}$/);
assert.equal(await linkedAccount("telegram", user), null);
await redeemLinkCode(code, account);
assert.equal(await linkedAccount("telegram", user), account, "the code links the chat to the signed-in account");
await assert.rejects(redeemLinkCode(code, "mallory.opencash.near"), /invalid, used or expired/, "a code works once");

const notice = (await db().query("select body from chat_outbox where chat_user_id = $1", [user])).rows[0];
assert.match(notice.body, /Security notice: Telegram chat @ada was just connected/, "linking tells every connected chat");
await db().query("delete from chat_outbox where chat_user_id = $1", [user]);
await notifyAccount(account, "hello");
await notifyAccount("someone-else.opencash.near", "not for you");
const sent: string[] = [];
let fail = true;
await dispatchOutbox({ telegram: async (chat, body) => { if (fail) throw new Error("down"); sent.push(`${chat}:${body}`); } });
let row = (await db().query("select status, attempts from chat_outbox where chat_user_id = $1", [user])).rows[0];
assert.deepEqual([row.status, row.attempts], ["pending", 1], "a failed send is retried later");
fail = false;
await db().query("update chat_outbox set next_attempt_at = now() where chat_user_id = $1", [user]);
await dispatchOutbox({ telegram: async (chat, body) => { sent.push(`${chat}:${body}`); } });
assert.deepEqual(sent, [`${user}:hello`], "only this account's chats get its notifications");
row = (await db().query("select status from chat_outbox where chat_user_id = $1", [user])).rows[0];
assert.equal(row.status, "sent");

const calls: { method: string; body: Record<string, unknown> }[] = [];
let served = false;
const fakeFetch = (async (url: string, init: RequestInit) => {
  const method = String(url).split("/").pop()!;
  const body = JSON.parse(String(init.body));
  calls.push({ method, body });
  const result =
    method === "getUpdates" && !served
      ? ((served = true),
        [
          { update_id: 7, message: { chat: { id: 4242, type: "private" }, from: { username: "ada" }, text: "/help" } },
          { update_id: 8, message: { chat: { id: -100, type: "group" }, text: "balance" } },
        ])
      : method === "getUpdates"
        ? []
        : {};
  return new Response(JSON.stringify({ ok: true, result }));
}) as typeof fetch;
const bot = telegram("TEST", () => undefined, fakeFetch);
bot.start();
await new Promise((resolve) => setTimeout(resolve, 300));
bot.stop();
const reply = calls.find((c) => c.method === "sendMessage" && c.body.chat_id === "4242");
assert.equal(reply?.body.text, helpText, "the bot answers /help");
const group = calls.find((c) => c.method === "sendMessage" && c.body.chat_id === "-100");
assert.match(String(group?.body.text), /only work in a private chat/, "groups are refused");
assert.equal(calls.filter((c) => c.method === "getUpdates")[1]?.body.offset, 9, "the next poll acknowledges both updates");

await db().query("delete from chat_outbox where chat_user_id = $1 or body = 'not for you'", [user]);
await db().query("delete from chat_links where chat_user_id = $1", [user]);
await db().end();
console.log("chat checks ok");
