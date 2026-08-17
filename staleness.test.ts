import { expect, test } from "vitest";
import { isStale, timeAgo } from "./lib/staleness";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

test("timeAgo advances with the clock", () => {
  const published = 1_000_000_000;
  expect(timeAgo(published, published + 10_000)).toBe("just now");
  expect(timeAgo(published, published + 5 * MINUTE)).toBe("5m ago");
  expect(timeAgo(published, published + 3 * HOUR)).toBe("3h ago");
  expect(timeAgo(published, published + 50 * HOUR)).toBe("2d ago");
});

test("isStale crosses the one-hour threshold and ignores archived flows", () => {
  const flow = { archived: false, updatedAt: 1_000_000_000 };
  expect(isStale(flow, flow.updatedAt + 59 * MINUTE)).toBe(false);
  expect(isStale(flow, flow.updatedAt + 61 * MINUTE)).toBe(true);
  expect(isStale({ ...flow, archived: true }, flow.updatedAt + 61 * MINUTE)).toBe(
    false,
  );
});
