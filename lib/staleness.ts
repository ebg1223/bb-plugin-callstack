// Pure time logic for flow cards; kept out of the React file so it is
// testable without the bb frontend build's path aliases.
import type { StoredFlow } from "../flow-schema";

const STALE_AFTER_MS = 60 * 60 * 1000;

export function isStale(
  flow: Pick<StoredFlow, "archived" | "updatedAt">,
  now: number,
): boolean {
  return !flow.archived && now - flow.updatedAt > STALE_AFTER_MS;
}

export function timeAgo(timestamp: number, now: number): string {
  const minutes = Math.round((now - timestamp) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
