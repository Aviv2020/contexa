type Handler<T> = (payload: T) => void;

export class Emitter<E extends Record<string, unknown>> {
  private handlers = new Map<keyof E, Set<Handler<never>>>();
  on<K extends keyof E>(event: K, h: Handler<E[K]>): () => void {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(h as Handler<never>);
    return () => {
      this.handlers.get(event)!.delete(h as Handler<never>);
    };
  }
  emit<K extends keyof E>(event: K, payload: E[K]): void {
    this.handlers.get(event)?.forEach((h) => (h as Handler<E[K]>)(payload));
  }
}

export const bus = new Emitter<{
  messages: { orgId: string; groupIds: string[] };
  groups: { orgId: string };
  keys: { orgId: string; groupId: string };
  wiped: { orgId: string; reason: string };
  removedFromGroup: { orgId: string; groupId: string };
  syncProgress: { orgId: string; syncing: boolean; oldestComplete: number | null };
  connection: { online: boolean };
}>();
