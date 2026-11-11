// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ChannelMessage, ChannelWindow } from "../relay/contracts";
import type { RelaySession } from "../relay/session";
import { newChat, useRegionWorkspace } from "./chat-workspace";

const navigation = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const filed = { id: "workspace", file: async () => {} };
  let value = {
    regions: [
      {
        channels: [{ id: "chat" }],
        source: { workspace: () => filed },
      },
    ],
    excluded: new Set<string>(),
    binding: { scope: "scope", viewer: "viewer", incarnation: "1" },
  };
  return {
    filed,
    listeners,
    // A channel-list change publishes a new snapshot with the same regions.
    publish() {
      value = { ...value };
      for (const listener of listeners) listener();
    },
    reader: {
      subscribe(listener: () => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      snapshot: () => value,
    },
  };
});
vi.mock("../channel-navigation/solo-navigation", async (original) => ({
  ...(await original<typeof import("../channel-navigation/solo-navigation")>()),
  soloNavigationFor: () => navigation.reader,
}));
afterEach(cleanup);

const window = (extra: Partial<ChannelWindow> = {}): ChannelWindow => ({
  channelId: "chat",
  status: "ready",
  rows: [],
  hasMore: false,
  loadingOlder: false,
  error: undefined,
  freshness: "verified",
  ...extra,
});
const row = (extra: Partial<ChannelMessage> = {}) =>
  ({ id: "m", ...extra }) as ChannelMessage;

it("calls a chat new only while its verified, complete history has no message", () => {
  expect(newChat(window())).toBe(true);
  // The agent joining a new task chat is not a message.
  expect(newChat(window({ rows: [row({ membership: {} as never })] }))).toBe(
    true,
  );
  expect(newChat(window({ rows: [row()] }))).toBe(false);
});

it("never calls a chat new before its history is known", () => {
  expect(newChat(undefined)).toBe(false);
  for (const extra of [
    { status: "loading" },
    { status: "idle" },
    { status: "error" },
    { freshness: "cached" },
    { freshness: undefined },
    { refreshing: true },
    { loadingOlder: true },
    { hasMore: true },
    { historyLimited: true },
    { hasNewer: true },
  ] as const)
    expect(newChat(window(extra as Partial<ChannelWindow>))).toBe(false);
});

it("renders again for Solo navigation only while it is given a chat", () => {
  const session = {} as RelaySession;
  let renders = 0;
  const { result, rerender } = renderHook(
    ({ channelId }: { channelId: string | undefined }) => {
      renders++;
      return useRegionWorkspace(session, channelId);
    },
    { initialProps: { channelId: undefined as string | undefined } },
  );
  expect(result.current).toBeUndefined();
  expect(navigation.listeners.size).toBe(0);
  act(() => navigation.publish());
  expect(renders).toBe(1);

  rerender({ channelId: "chat" });
  expect(result.current).toBe(navigation.filed);
  const before = renders;
  act(() => navigation.publish());
  expect(renders).toBe(before + 1);
  expect(result.current).toBe(navigation.filed);

  rerender({ channelId: undefined });
  expect(navigation.listeners.size).toBe(0);
  const left = renders;
  act(() => navigation.publish());
  expect(renders).toBe(left);
  expect(result.current).toBeUndefined();
});
