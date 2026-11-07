/** Handles one custom-mempool gossip message; throwing means "do not forward". */
export type CustomGossipHandler = (
  data: Uint8Array,
  peer: string
) => Promise<void> | void;

type Publisher = (mempoolId: string, data: Uint8Array) => Promise<number>;
type Subscriber = (mempoolId: string) => void;

/**
 * Bridge between ERC-8421 non-standard alternative mempools (loaded by the
 * API) and the p2p network (node mode only). Each custom mempool gossips on
 * its own topic, keyed by its mempool id. In standalone mode no network is
 * attached: publishing reaches no peers and nothing is received.
 */
export class CustomMempoolGossip {
  private handlers = new Map<string, CustomGossipHandler>();
  private publisher: Publisher | null = null;
  private subscriber: Subscriber | null = null;

  attachNetwork(publish: Publisher, subscribe: Subscriber): void {
    this.publisher = publish;
    this.subscriber = subscribe;
    for (const mempoolId of this.handlers.keys()) subscribe(mempoolId);
  }

  get networked(): boolean {
    return this.publisher !== null;
  }

  register(mempoolId: string, handler: CustomGossipHandler): void {
    if (this.handlers.has(mempoolId)) {
      throw new Error(`custom mempool ${mempoolId} already registered`);
    }
    this.handlers.set(mempoolId, handler);
    this.subscriber?.(mempoolId);
  }

  /** Returns the number of peers the message was sent to. */
  async publish(mempoolId: string, data: Uint8Array): Promise<number> {
    return this.publisher ? this.publisher(mempoolId, data) : 0;
  }

  async deliver(mempoolId: string, data: Uint8Array, peer: string): Promise<void> {
    const handler = this.handlers.get(mempoolId);
    if (!handler) throw new Error(`no custom mempool ${mempoolId}`);
    await handler(data, peer);
  }
}
