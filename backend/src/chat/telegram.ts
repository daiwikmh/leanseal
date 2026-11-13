import { handleMessage } from "./core.js";

type Update = {
  update_id: number;
  message?: { chat: { id: number; type: string }; from?: { username?: string; first_name?: string }; text?: string };
};

export function telegram(token: string, log: (message: string) => void, fetcher: typeof fetch = fetch) {
  const base = `https://api.telegram.org/bot${token}`;
  let running = false;

  async function call<T>(method: string, body: Record<string, unknown>, timeoutMs = 15_000): Promise<T> {
    const response = await fetcher(`${base}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const json = (await response.json()) as { ok: boolean; result: T; description?: string };
    if (!json.ok) throw new Error(`Telegram ${method}: ${json.description ?? response.status}`);
    return json.result;
  }

  async function send(chatId: string, text: string) {
    await call("sendMessage", { chat_id: chatId, text, disable_web_page_preview: true });
  }

  async function respond(message: { chat: { id: number; type: string }; from?: { username?: string; first_name?: string }; text: string }) {
    const chatId = String(message.chat.id);
    const label = message.from?.username ? `@${message.from.username}` : (message.from?.first_name ?? "");
    const reply =
      message.chat.type !== "private"
        ? "For your security I only work in a private chat. Message me directly."
        : await handleMessage("telegram", chatId, message.text, label).catch((error) => `Something went wrong: ${error instanceof Error ? error.message : String(error)}`);
    await send(chatId, reply).catch((error) => log(`telegram reply failed: ${String(error)}`));
  }

  async function loop() {
    let offset = 0;
    while (running) {
      try {
        const updates = await call<Update[]>("getUpdates", { offset, timeout: 25, allowed_updates: ["message"] }, 35_000);
        if (updates.length === 0) await new Promise((resolve) => setTimeout(resolve, 500));
        for (const update of updates) {
          offset = update.update_id + 1;
          const message = update.message;
          if (!message?.text) continue;
          void respond(message as Required<Update>["message"] & { text: string });
        }
      } catch (error) {
        log(`telegram poll failed: ${String(error)}`);
        await new Promise((resolve) => setTimeout(resolve, 5_000));
      }
    }
  }

  return {
    send,
    start() {
      running = true;
      void loop();
    },
    stop() {
      running = false;
    },
  };
}
