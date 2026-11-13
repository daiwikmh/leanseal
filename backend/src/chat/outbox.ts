import { randomBytes } from "node:crypto";
import { db } from "../db.js";

export type Platform = "telegram" | "xmtp";
export type Sender = (chatUserId: string, body: string) => Promise<void>;

const retryMinutes = [1, 5, 30];
const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";

export async function enqueue(platform: Platform, chatUserId: string, body: string) {
  await db().query("insert into chat_outbox (platform, chat_user_id, body) values ($1, $2, $3)", [platform, chatUserId, body.slice(0, 4000)]);
}

export async function notifyAccount(accountId: string, body: string) {
  await db().query(
    "insert into chat_outbox (platform, chat_user_id, body) select platform, chat_user_id, $2 from chat_links where account_id = $1",
    [accountId, body.slice(0, 4000)],
  );
}

export async function linkedAccount(platform: Platform, chatUserId: string): Promise<string | null> {
  const { rows } = await db().query<{ account_id: string }>("select account_id from chat_links where platform = $1 and chat_user_id = $2", [platform, chatUserId]);
  return rows[0]?.account_id ?? null;
}

export async function createLinkCode(platform: Platform, chatUserId: string, label: string): Promise<string> {
  const code = Array.from(randomBytes(12), (b) => alphabet[b % alphabet.length]).join("");
  await db().query(
    "insert into chat_link_codes (code, platform, chat_user_id, label, expires_at) values ($1, $2, $3, $4, now() + interval '15 minutes')",
    [code, platform, chatUserId, label.slice(0, 120)],
  );
  return code;
}

export async function describeLinkCode(code: string): Promise<{ platform: Platform; label: string }> {
  const { rows } = await db().query<{ platform: Platform; label: string }>(
    "select platform, label from chat_link_codes where code = $1 and used_at is null and expires_at > now()",
    [code],
  );
  if (!rows[0]) throw Object.assign(new Error("This link code is invalid, used or expired. Ask the bot for a new one with: link"), { statusCode: 404 });
  return rows[0];
}

export async function listLinks(accountId: string) {
  const { rows } = await db().query<{ platform: Platform; chat_user_id: string; label: string; linked_at: Date }>(
    "select platform, chat_user_id, label, linked_at from chat_links where account_id = $1 order by linked_at desc",
    [accountId],
  );
  return rows.map((r) => ({ ...r, linked_at: r.linked_at.toISOString() }));
}

export async function unlinkFor(accountId: string, platform: Platform, chatUserId: string) {
  const { rowCount } = await db().query("delete from chat_links where account_id = $1 and platform = $2 and chat_user_id = $3", [accountId, platform, chatUserId]);
  if (rowCount) await enqueue(platform, chatUserId, `Disconnected from ${accountId} from the opencash dashboard.`);
}

export async function redeemLinkCode(code: string, accountId: string): Promise<{ platform: Platform; chatUserId: string; label: string }> {
  const { rows } = await db().query<{ platform: Platform; chat_user_id: string; label: string }>(
    "update chat_link_codes set used_at = now() where code = $1 and used_at is null and expires_at > now() returning platform, chat_user_id, label",
    [code],
  );
  const row = rows[0];
  if (!row) throw Object.assign(new Error("This link code is invalid, used or expired. Ask the bot for a new one with /link."), { statusCode: 400 });
  await db().query(
    `insert into chat_links (platform, chat_user_id, account_id, label) values ($1, $2, $3, $4)
     on conflict (platform, chat_user_id) do update set account_id = excluded.account_id, label = excluded.label, linked_at = now()`,
    [row.platform, row.chat_user_id, accountId, row.label],
  );
  await notifyAccount(accountId, `Security notice: ${row.platform === "xmtp" ? "XMTP" : "Telegram"} chat ${row.label || row.chat_user_id} was just connected to ${accountId}. If this wasn't you, disconnect it in Account › Chat.`);
  return { platform: row.platform, chatUserId: row.chat_user_id, label: row.label };
}

export async function unlink(platform: Platform, chatUserId: string) {
  await db().query("delete from chat_links where platform = $1 and chat_user_id = $2", [platform, chatUserId]);
}

export async function dispatchOutbox(senders: Partial<Record<Platform, Sender>>) {
  const platforms = Object.keys(senders) as Platform[];
  if (platforms.length === 0) return;
  const { rows } = await db().query<{ id: string; platform: Platform; chat_user_id: string; body: string; attempts: number }>(
    "select id, platform, chat_user_id, body, attempts from chat_outbox where status = 'pending' and next_attempt_at <= now() and platform = any($1) order by created_at limit 50",
    [platforms],
  );
  for (const row of rows) {
    try {
      await senders[row.platform]!(row.chat_user_id, row.body);
      await db().query("update chat_outbox set status = 'sent', attempts = attempts + 1, sent_at = now() where id = $1", [row.id]);
    } catch (error) {
      const wait = retryMinutes[row.attempts];
      await db().query(
        "update chat_outbox set attempts = attempts + 1, last_error = $2, status = $3, next_attempt_at = now() + make_interval(mins => $4) where id = $1",
        [row.id, String(error).slice(0, 300), wait === undefined ? "failed" : "pending", wait ?? 0],
      );
    }
  }
}
