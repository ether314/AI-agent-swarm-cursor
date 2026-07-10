import type { WsEvent } from "@corp-swarm/schema";

type Listener = (event: WsEvent) => void;

class EventBus {
  private listeners = new Set<Listener>();

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: WsEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        console.error("event bus listener error", err);
      }
    }
  }
}

export const bus = new EventBus();
