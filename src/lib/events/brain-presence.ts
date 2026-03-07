import { broadcast } from "./activity-events.js";

/** Ref-counted map of username → active SSE connection count. */
const connections = new Map<string, number>();

export function addConnection(username: string): void {
  const count = connections.get(username) ?? 0;
  connections.set(username, count + 1);
  if (count === 0) {
    broadcast({ type: "brain_online", mind: username, summary: `${username} connected` });
  }
}

export function removeConnection(username: string): void {
  const count = connections.get(username);
  if (count == null) return;
  if (count <= 1) {
    connections.delete(username);
    broadcast({ type: "brain_offline", mind: username, summary: `${username} disconnected` });
  } else {
    connections.set(username, count - 1);
  }
}

export function getOnlineBrains(): string[] {
  return [...connections.keys()];
}
