import { Agent } from "@xmtp/agent-sdk";
import { handleMessage } from "./core.js";

export async function xmtp(log: (message: string) => void) {
  const agent = await Agent.createFromEnv();

  agent.on("text", async (ctx) => {
    const conversationId = ctx.conversation.id;
    const label = (await ctx.getSenderAddress().catch(() => undefined)) ?? "";
    const reply = !ctx.isDm()
      ? "For your security I only work in direct messages. Message me directly."
      : await handleMessage("xmtp", conversationId, ctx.message.content, label).catch(
          (error) => `Something went wrong: ${error instanceof Error ? error.message : String(error)}`,
        );
    await ctx.conversation.sendText(reply).catch((error) => log(`xmtp reply failed: ${String(error)}`));
  });
  agent.on("unhandledError", (error) => log(`xmtp error: ${String(error)}`));
  await agent.start();
  log(`xmtp agent online at ${agent.address}`);

  return {
    address: agent.address,
    async send(conversationId: string, text: string) {
      const ctx = await agent.getConversationContext(conversationId);
      if (!ctx) throw new Error(`XMTP conversation ${conversationId} not found`);
      await ctx.conversation.sendText(text);
    },
    stop: () => agent.stop(),
  };
}
