type Handler<T> = (payload: T) => void;

export class Emitter<Events extends Record<string, unknown>> {
  private readonly handlers = new Map<keyof Events, Set<Handler<never>>>();

  on<K extends keyof Events>(event: K, handler: Handler<Events[K]>): () => void {
    let set = this.handlers.get(event);
    if (!set) this.handlers.set(event, (set = new Set()));
    set.add(handler as Handler<never>);
    return () => set.delete(handler as Handler<never>);
  }

  protected emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    for (const handler of this.handlers.get(event) ?? []) (handler as Handler<Events[K]>)(payload);
  }
}
