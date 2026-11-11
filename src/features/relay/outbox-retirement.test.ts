import { afterEach, assert, expect, it, vi } from "vitest";
import { createOutbox, type OutgoingEvent } from "./outbox";
import { keypair, signed } from "./testing";

const viewer = keypair();
const recovery = { key: "follow-up:example", value: "completed" };
const event = signed(viewer, {
  kind: 9,
  created_at: 1,
  content: "Follow-up",
  tags: [["h", "example"]],
});
const receipt: OutgoingEvent = {
  event,
  signed: event,
  guarded: true,
  recovery,
  delivery: "unknown",
};
const owners: ReturnType<typeof createOutbox>[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
  vi.useRealTimers();
});

function setup(records: readonly OutgoingEvent[] = [receipt]) {
  let rows = records;
  const retired = new Set<string>();
  const storage = {
    load: () => rows,
    save: vi.fn(async (next: readonly OutgoingEvent[]) => {
      rows = next.filter((item) => !retired.has(item.event.id));
    }),
    retire: vi.fn(async (id: string) => {
      retired.add(id);
      rows = rows.filter((item) => item.event.id !== id);
    }),
  };
  const sign = vi.fn(async (input) => signed(viewer, input));
  const publish = vi.fn(async () => {});
  const owner = createOutbox(viewer.pubkey, { sign, publish }, storage);
  owners.push(owner);
  return { ...owner, storage, sign, publish };
}

it("retires a restored unknown receipt without signing or publishing", async () => {
  const other = signed(viewer, { ...event, content: "Unrelated" });
  const h = setup([receipt, { event: other, delivery: "failed" }]);
  await h.ready;
  await expect(h.outbox.dismiss(event.id)).rejects.toThrow(
    "Confirm this message",
  );
  await expect(h.outbox.retire(event.id, recovery)).resolves.toBe("retired");
  await expect(h.outbox.retire(event.id, recovery)).resolves.toBe("retired");
  expect(h.outbox.snapshot().map((row) => row.event.id)).toEqual([other.id]);
  expect(h.storage.load().map((row) => row.event.id)).toEqual([other.id]);
  expect(h.local.snapshot().map((row) => row.event.id)).toEqual([other.id]);
  expect(h.sign).not.toHaveBeenCalled();
  expect(h.publish).not.toHaveBeenCalled();
});

it.each([
  { guarded: false, recovery },
  { guarded: true, recovery: { ...recovery, value: "different" } },
  { guarded: true, recovery: undefined },
])("preserves a receipt that does not match retirement: %j", async (fields) => {
  const h = setup([{ ...receipt, ...fields }]);
  await h.ready;
  await expect(h.outbox.retire(event.id, recovery)).rejects.toThrow(
    "does not match",
  );
  expect(h.outbox.snapshot()).toHaveLength(1);
  expect(h.storage.retire).not.toHaveBeenCalled();
});

it("preserves local intent on storage failure and permits a later cleanup", async () => {
  const h = setup();
  await h.ready;
  h.storage.retire.mockRejectedValueOnce(new Error("Disk full"));
  await expect(h.outbox.retire(event.id, recovery)).rejects.toThrow(
    "Disk full",
  );
  expect(h.outbox.snapshot()).toHaveLength(1);
  await expect(h.outbox.retire(event.id, recovery)).resolves.toBe("retired");
  expect(h.outbox.snapshot()).toEqual([]);
});

it("keeps active delivery pending and retires after timeout without joining a stalled save", async () => {
  vi.useFakeTimers();
  const h = setup([]);
  await h.ready;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const saving = new Promise<void>((resolve) => {
    started = resolve;
  });
  const save = h.storage.save.getMockImplementation();
  assert.exists(save);
  h.storage.save.mockImplementationOnce(async (rows) => {
    started();
    await gate;
    await save(rows);
  });
  let active = true;
  const id = h.outbox.send(
    { kind: 9, content: "Pending", tags: [["h", "example"]] },
    recovery,
    () => active,
  );
  try {
    await saving;
    active = false;
    await expect(h.outbox.retire(id, recovery)).resolves.toBe("pending");
    await vi.advanceTimersByTimeAsync(10_001);
    await expect(h.outbox.retire(id, recovery)).resolves.toBe("retired");
    expect(h.outbox.snapshot()).toEqual([]);
  } finally {
    release();
  }
  // This dismissal joins the old save and its queued status write.
  await h.outbox.dismiss(id);
  expect(h.storage.load()).toEqual([]);
  expect(h.sign).not.toHaveBeenCalled();
  expect(h.publish).not.toHaveBeenCalled();
});

it("requires revoked admission after a definitive failure", async () => {
  const h = setup([]);
  await h.ready;
  h.sign.mockRejectedValue(new Error("Signer unavailable"));
  let active = true;
  const id = h.outbox.send(
    { kind: 9, content: "Pending", tags: [["h", "example"]] },
    recovery,
    () => active,
  );
  await vi.waitFor(() =>
    expect(h.outbox.snapshot()[0]?.delivery).toBe("failed"),
  );
  await expect(h.outbox.retire(id, recovery)).resolves.toBe("pending");
  active = false;
  await expect(h.outbox.retire(id, recovery)).resolves.toBe("retired");
  expect(h.publish).not.toHaveBeenCalled();
});

it("blocks retry and adoption while retirement commits", async () => {
  const h = setup();
  await h.ready;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const retiring = new Promise<void>((resolve) => {
    started = resolve;
  });
  const retire = h.storage.retire.getMockImplementation();
  assert.exists(retire);
  h.storage.retire.mockImplementationOnce(async (id) => {
    started();
    await gate;
    await retire(id);
  });
  const work = h.outbox.retire(event.id, recovery);
  try {
    await retiring;
    h.outbox.retry(event.id, () => true);
    await expect(h.outbox.recover(event.id, recovery)).rejects.toThrow();
    await expect(h.outbox.retire(event.id, recovery)).resolves.toBe("pending");
  } finally {
    release();
  }
  await expect(work).resolves.toBe("retired");
  expect(h.sign).not.toHaveBeenCalled();
  expect(h.publish).not.toHaveBeenCalled();
});
