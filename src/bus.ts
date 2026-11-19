type Handler = (payload: unknown) => void | Promise<void>;

export class Bus {
  private handlers = new Map<string, Handler[]>();

  on(event: string, fn: Handler): () => void {
    const list = this.handlers.get(event) ?? [];
    list.push(fn);
    this.handlers.set(event, list);
    return () => {
      const next = (this.handlers.get(event) ?? []).filter((item) => item !== fn);
      this.handlers.set(event, next);
    };
  }

  async emit(event: string, payload: unknown): Promise<void> {
    for (const fn of this.handlers.get(event) ?? []) {
      await fn(payload);
    }
  }
}
