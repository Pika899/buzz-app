import { Context } from "@deepseek-ai/cordis";
import { afterEach, expect, it, vi } from "vitest";
import { SessionControls } from "../agent-harness/session-control";
import type { AgentKey } from "./membership";
import {
  createSessionAdmissions,
  type AgentSessionAdmission,
  type AgentSessionRouter,
} from "./session-admission";
import { memoryStorage } from "./test-fakes";

const roots: Context[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await root.fiber.dispose();
});
const agent = "a".repeat(64) as AgentKey;
const source = { channelId: "channel", root: "b".repeat(64) };
const signal = new AbortController().signal;
const request = (invocationId: string) => ({
  agent,
  owner: "c".repeat(64),
  harness: "example/native",
  source,
  conversation: { channelId: "channel" },
  invocationId,
  resumed: false,
  signal,
});
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function setup(
  callbacks: Partial<AgentSessionRouter> = {},
  storage = memoryStorage(),
) {
  const root = new Context();
  roots.push(root);
  root.provide("pluginStatus", {
    isActive: () => true,
    subscribe: () => () => {},
  });
  const admissions = createSessionAdmissions(root, storage);
  const prepare = vi.fn(async (input: AgentSessionAdmission) => ({
    association: input.association ?? { task: input.sessionKey },
    context: "Session context",
  }));
  await root
    .extend({ pluginOwner: { id: "example", revision: "one" } })
    .plugin((ctx) =>
      admissions.register(ctx, {
        id: "tasks",
        ready: async () => {},
        matches: () => true,
        prepare,
        ...callbacks,
      }),
    )
    .await();
  return { admissions, prepare, storage };
}

it("keeps the saved route, association and context across follow-up and restore", async () => {
  const route = vi.fn(async () => "source-thread" as const);
  const f = await setup({ route });
  const selected = await f.admissions.resolve(request("first"));
  expect(selected?.conversation).toEqual(source);
  expect(f.prepare).not.toHaveBeenCalled();
  const first = await selected?.prepare(signal);
  expect(first?.context).toBe("Session context");
  expect(f.prepare.mock.calls[0]?.[0]).toMatchObject({
    source,
    conversation: source,
    intent: "new",
    adopted: false,
  });
  first?.acknowledged();
  const restored = await setup({ route }, f.storage);
  const next = await (
    await restored.admissions.resolve(request("follow-up"))
  )?.prepare(signal);
  expect(next?.session).toEqual(first?.session);
  expect(next?.context).toBeUndefined();
  expect(restored.prepare.mock.calls[0]?.[0]).toMatchObject({
    intent: "existing",
    association: first?.session.association,
  });
  expect(route).toHaveBeenCalledOnce();
});

it("adopts a default lifetime and waits only for router readiness", async () => {
  const ready = gate();
  const matched = vi.fn(() => true);
  const f = await setup({ ready: () => ready.promise, matches: matched });
  const resolving = f.admissions.resolve(request("first"));
  expect(matched).not.toHaveBeenCalled();
  ready.resolve();
  const selected = await resolving;
  expect(selected?.conversation).toEqual({ channelId: "channel" });
  await selected?.prepare(signal);
  expect(f.prepare.mock.calls[0]?.[0]).toMatchObject({
    intent: "existing",
    adopted: true,
    source,
  });
});

it("drops a declined fresh route and preserves an accepted association", async () => {
  const prepare = vi
    .fn<AgentSessionRouter["prepare"]>()
    .mockResolvedValueOnce(undefined)
    .mockResolvedValueOnce({ association: { task: "one" } })
    .mockResolvedValueOnce(undefined);
  const f = await setup({ route: () => "source-thread", prepare });
  expect(
    await (await f.admissions.resolve(request("first")))?.prepare(signal),
  ).toBeUndefined();
  expect(
    f.admissions.conversation(agent, "example/native", source),
  ).toBeUndefined();
  const next = await f.admissions.resolve(request("second"));
  expect((await next?.prepare(signal))?.session.association).toEqual({
    task: "one",
  });
  await expect(
    (await f.admissions.resolve(request("third")))?.prepare(signal),
  ).rejects.toThrow("cannot restore");
});

it("defers admission during New and rejects replay from the retired lifetime", async () => {
  const f = await setup({ route: () => "source-thread" });
  const first = await (await f.admissions.resolve(request("first")))?.prepare(
    signal,
  );
  const controls = new SessionControls(() => {});
  const nativeReset = gate();
  const resetStarted = gate();
  const reset = controls.run("session", "new", () =>
    f.admissions.reset(agent, "example/native", source, async () => {
      resetStarted.resolve();
      await nativeReset.promise;
    }),
  );
  await resetStarted.promise;
  const selected = await f.admissions.resolve(request("during-new"));
  const handoff = controls.deliver("session", async (deferred) => {
    expect(deferred).toBe(true);
    const next = await selected?.prepare(signal);
    expect(next?.session.sessionKey).not.toBe(first?.session.sessionKey);
  });
  expect(handoff.deferred).toBe(true);
  expect(f.prepare).toHaveBeenCalledOnce();
  nativeReset.resolve();
  await reset;
  await handoff.done;
  await expect(
    (await f.admissions.resolve(request("first")))?.prepare(signal),
  ).rejects.toThrow("earlier session");
});

it("blocks admission after a failed reset until New completes", async () => {
  const f = await setup({ route: () => "source-thread" });
  await (await f.admissions.resolve(request("first")))?.prepare(signal);
  await expect(
    f.admissions.reset(agent, "example/native", source, async () => {
      throw new Error("Reset cancelled");
    }),
  ).rejects.toThrow("Reset cancelled");
  await expect(
    (await f.admissions.resolve(request("after-failure")))?.prepare(signal),
  ).rejects.toThrow("reset is incomplete");
  await f.admissions.reset(agent, "example/native", source, async () => {});
  const next = await (
    await f.admissions.resolve(request("after-recovery"))
  )?.prepare(signal);
  expect(next?.session.sessionKey).toBeTruthy();
});

it("rejects an unverified thread before plugin preparation", async () => {
  const f = await setup({ route: () => "source-thread" });
  await expect(
    f.admissions.resolve({
      ...request("bad"),
      source: { channelId: "channel" },
    }),
  ).rejects.toThrow("verified root");
  expect(f.prepare).not.toHaveBeenCalled();
});
