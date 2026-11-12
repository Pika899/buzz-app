import { test, expect } from "./source-fixture.mjs";

for (const initialSave of ["before-retirement", "after-retirement"])
  test(`retirement excludes stale saves across windows and restart (${initialSave})`, async ({
    page,
    context,
    sourceOrigin,
  }) => {
    await context.route(`${sourceOrigin}/outbox-retirement-test`, (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><title>Outbox retirement</title>",
      }),
    );
    const peer = await context.newPage();
    await Promise.all([
      page.goto(`${sourceOrigin}/outbox-retirement-test`),
      peer.goto(`${sourceOrigin}/outbox-retirement-test`),
    ]);
    const scope = `retirement-${crypto.randomUUID()}`;
    const recovery = { key: "follow-up:example", value: "completed" };
    const old = {
      event: { id: "old" },
      recovery,
      guarded: true,
      delivery: "unknown",
    };
    const other = { event: { id: "other" }, delivery: "sending" };
    await peer.evaluate(
      async ({ scope, old, initialSave }) => {
        const { browserOutboxStorage } = await import(
          "/src/features/relay/outbox-storage.ts"
        );
        window.retirementStore = browserOutboxStorage(scope);
        await window.retirementStore.load();
        if (initialSave === "before-retirement")
          await window.retirementStore.save([old]);
      },
      { scope, old, initialSave },
    );
    try {
      await page.evaluate(
        async ({ scope, recovery }) => {
          const { browserOutboxStorage } = await import(
            "/src/features/relay/outbox-storage.ts"
          );
          const store = browserOutboxStorage(scope);
          try {
            await store.retire("old", recovery);
          } finally {
            store.close();
          }
        },
        { scope, recovery },
      );
      await peer.evaluate(
        async ({ old, other }) => {
          await window.retirementStore.save([
            { ...old, delivery: "failed" },
            other,
          ]);
          // A later unrelated save captures the same obsolete local row.
          await window.retirementStore.save([
            old,
            { ...other, delivery: "accepted" },
          ]);
          window.retirementStore.close();
        },
        { old, other },
      );
      await peer.reload();
      const result = await peer.evaluate(
        async ({ scope, old }) => {
          const { browserOutboxStorage } = await import(
            "/src/features/relay/outbox-storage.ts"
          );
          const store = browserOutboxStorage(scope);
          const isolated = browserOutboxStorage(`${scope}-other`);
          try {
            const restored = await store.load();
            await store.save([...restored, old]);
            await isolated.save([old]);
            const durable = await new Promise((resolve, reject) => {
              const request = indexedDB.open("buzz-outbox-v2", 2);
              request.onerror = () => reject(request.error);
              request.onsuccess = () => {
                const db = request.result;
                const tx = db.transaction("events");
                const rows = tx
                  .objectStore("events")
                  .index("scope")
                  .getAll(IDBKeyRange.only(scope));
                tx.oncomplete = () => {
                  db.close();
                  resolve(rows.result.map((row) => row.id));
                };
                tx.onabort = () => {
                  db.close();
                  reject(tx.error);
                };
              };
            });
            await store.retire("old", old.recovery);
            return {
              durable,
              ids: (await store.load({ readOnly: true })).map(
                (row) => row.event.id,
              ),
              isolated: (await isolated.load()).map((row) => row.event.id),
            };
          } finally {
            store.close();
            isolated.close();
          }
        },
        { scope, old },
      );
      expect(result).toEqual({
        durable: ["other"],
        ids: ["other"],
        isolated: ["old"],
      });
    } finally {
      await peer.evaluate(
        async ({ scope }) => {
          window.retirementStore?.close();
          const { purgeOutboxStorage } = await import(
            "/src/features/relay/outbox-storage.ts"
          );
          await purgeOutboxStorage(scope);
          await purgeOutboxStorage(`${scope}-other`);
        },
        { scope },
      );
    }
  });

test("retirement checks recovery identity and guard before durable removal", async ({
  page,
  context,
  sourceOrigin,
}) => {
  await context.route(`${sourceOrigin}/outbox-retirement-test`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Outbox retirement</title>",
    }),
  );
  await page.goto(`${sourceOrigin}/outbox-retirement-test`);
  const result = await page.evaluate(async () => {
    const { browserOutboxStorage, purgeOutboxStorage } = await import(
      "/src/features/relay/outbox-storage.ts"
    );
    const scope = `identity-${crypto.randomUUID()}`;
    const store = browserOutboxStorage(scope);
    const recovery = { key: "follow-up:example", value: "completed" };
    const guarded = {
      event: { id: "guarded" },
      recovery,
      guarded: true,
      delivery: "unknown",
    };
    const unguarded = {
      event: { id: "unguarded" },
      recovery,
      delivery: "unknown",
    };
    const failures = [];
    try {
      await store.save([guarded, unguarded]);
      for (const [id, expected] of [
        ["guarded", { ...recovery, value: "wrong" }],
        ["unguarded", recovery],
      ]) {
        try {
          await store.retire(id, expected);
        } catch {
          failures.push(id);
        }
      }
      const before = (await store.load()).map((row) => row.event.id).sort();
      await store.retire("guarded", recovery);
      try {
        await store.retire("guarded", { ...recovery, key: "wrong" });
      } catch {
        failures.push("marker");
      }
      await store.save([guarded, unguarded]);
      const after = (await store.load()).map((row) => row.event.id);
      store.close();
      await purgeOutboxStorage(scope);
      const fresh = browserOutboxStorage(scope);
      try {
        await fresh.save([guarded]);
        return {
          failures,
          before,
          after,
          purged: (await fresh.load()).map((row) => row.event.id),
        };
      } finally {
        fresh.close();
      }
    } finally {
      store.close();
      await purgeOutboxStorage(scope);
    }
  });
  expect(result).toEqual({
    failures: ["guarded", "unguarded", "marker"],
    before: ["guarded", "unguarded"],
    after: ["unguarded"],
    purged: ["guarded"],
  });
});

test("retirement keeps a version 2 connection usable and excludes legacy rows", async ({
  page,
  context,
  sourceOrigin,
}) => {
  await context.route(`${sourceOrigin}/outbox-retirement-test`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Outbox retirement</title>",
    }),
  );
  await page.goto(`${sourceOrigin}/outbox-retirement-test`);
  const result = await page.evaluate(async () => {
    const scope = `migration-${crypto.randomUUID()}`;
    const recovery = { key: "follow-up:example", value: "completed" };
    const old = {
      event: { id: "old" },
      guarded: true,
      recovery,
      delivery: "unknown",
    };
    const other = { event: { id: "other" }, delivery: "failed" };
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("buzz-outbox-v2", 2);
      request.onupgradeneeded = () => {
        request.result.createObjectStore("partitions");
        request.result
          .createObjectStore("events", { keyPath: ["scope", "id"] })
          .createIndex("scope", "scope");
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const tx = db.transaction(["events", "partitions"], "readwrite");
      tx.objectStore("events").put({ scope, id: "other", operation: other });
      tx.objectStore("partitions").put(true, scope);
      tx.oncomplete = resolve;
      tx.onabort = () => reject(tx.error);
    });
    let versionChanged = false;
    db.onversionchange = () => {
      versionChanged = true;
      db.close();
    };
    localStorage.setItem(
      `buzz-outbox-v1:${scope}-legacy`,
      JSON.stringify([old, other]),
    );
    const { browserOutboxStorage, purgeOutboxStorage } = await import(
      "/src/features/relay/outbox-storage.ts"
    );
    const store = browserOutboxStorage(scope);
    const legacy = browserOutboxStorage(`${scope}-legacy`);
    try {
      const migrated = (await store.load()).map((row) => row.event.id);
      await store.retire("old", recovery);
      await store.save([old, other]);
      await legacy.retire("old", recovery);
      const rows = await legacy.load();
      await legacy.save(rows);
      const legacyRead = await new Promise((resolve, reject) => {
        const tx = db.transaction(["events", "partitions"]);
        const records = tx.objectStore("events").index("scope").getAll(scope);
        const partition = tx.objectStore("partitions").get(scope);
        tx.oncomplete = () =>
          resolve({
            ids: records.result.map((row) => row.operation.event.id),
            migrated: partition.result,
          });
        tx.onabort = () => reject(tx.error);
      });
      return {
        migrated,
        legacy: (await legacy.load()).map((row) => row.event.id),
        version: db.version,
        versionChanged,
        legacyRead,
      };
    } finally {
      db.close();
      store.close();
      legacy.close();
      await purgeOutboxStorage(scope);
      await purgeOutboxStorage(`${scope}-legacy`);
    }
  });
  expect(result).toEqual({
    migrated: ["other"],
    legacy: ["other"],
    version: 2,
    versionChanged: false,
    legacyRead: { ids: ["other"], migrated: true },
  });
});

// Exercise the actual incremental IndexedDB journal: a full-array memory store
// cannot reproduce a stale window deleting another window's renewed receipt.
test("forgetting a stale receipt relinquishes its journal deletion ownership", async ({
  page,
  context,
  sourceOrigin,
}) => {
  await context.route(`${sourceOrigin}/outbox-storage-test`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Outbox storage boundary</title>",
    }),
  );
  await page.goto(`${sourceOrigin}/outbox-storage-test`);
  const ids = await page.evaluate(async () => {
    const { browserOutboxStorage, purgeOutboxStorage } = await import(
      "/src/features/relay/outbox-storage.ts"
    );
    const scope = `stale-receipt-${crypto.randomUUID()}`;
    const owner = browserOutboxStorage(scope);
    const stale = browserOutboxStorage(scope);
    const old = { event: { id: "old" }, delivery: "failed" };
    const next = { event: { id: "next" }, delivery: "sending" };
    try {
      await owner.load();
      await owner.save([old]);
      await stale.load();
      await owner.save([]);
      if ((await stale.load({ readOnly: true })).length)
        throw new Error("Receipt was not removed");
      const pending = stale.save([old]);
      // save has entered its IndexedDB transaction, which cannot complete in
      // this microtask. Discard must survive that transaction's completion.
      await Promise.resolve();
      stale.forget(old.event.id);
      await pending;
      // A different window renews the same operation after the absence check.
      await owner.save([old]);
      await stale.save([next]);
      return (await owner.load({ readOnly: true }))
        .map((item) => item.event.id)
        .sort();
    } finally {
      owner.close();
      stale.close();
      await purgeOutboxStorage(scope);
    }
  });
  expect(ids).toEqual(["next", "old"]);
});

for (const mode of ["dismiss-first", "adopt-first", "peer-accepted"])
  test(`receipt adoption serializes queue consumption with dismissal (${mode})`, async ({
    page,
    context,
    sourceOrigin,
  }) => {
    await context.route(`${sourceOrigin}/outbox-adoption-test`, (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><title>Outbox adoption</title>",
      }),
    );
    await page.goto(`${sourceOrigin}/outbox-adoption-test`);
    const { finalizeEvent } = await import("nostr-tools");
    const event = finalizeEvent(
      {
        kind: 9,
        created_at: 1,
        content: "Saved message",
        tags: [["h", "chat"]],
      },
      new Uint8Array(32).fill(7),
    );
    const result = await page.evaluate(
      async ({ event, mode }) => {
        const { browserOutboxStorage, purgeOutboxStorage } = await import(
          "/src/features/relay/outbox-storage.ts"
        );
        const { createOutbox } = await import("/src/features/relay/outbox.ts");
        const recovery = { key: "follow-up:row", value: "row" };
        const scope = `adoption-${crypto.randomUUID()}`;
        const seed = browserOutboxStorage(scope);
        await seed.load();
        await seed.save([
          { event, signed: event, recovery, delivery: "failed" },
        ]);
        seed.close();
        const writer = {
          sign: async () => {
            throw new Error("Unexpected signing");
          },
          publish: async () => {
            throw new Error("Unexpected publishing");
          },
        };
        const a = createOutbox(
          event.pubkey,
          writer,
          browserOutboxStorage(scope),
        );
        const store = browserOutboxStorage(scope);
        let started;
        const saving = new Promise((resolve) => {
          started = resolve;
        });
        let resume;
        const gate = new Promise((resolve) => {
          resume = resolve;
        });
        const b = createOutbox(event.pubkey, writer, {
          ...store,
          load: async (options) => {
            const records = await store.load(options);
            if (options?.readOnly) {
              started();
              await gate;
            }
            return records;
          },
        });
        try {
          await Promise.all([a.ready, b.ready]);
          const order = [];
          if (mode === "dismiss-first") {
            resume();
            await b.outbox.recovery(recovery.key);
            await a.outbox.dismiss(event.id);
            let rejected = false;
            try {
              await b.outbox.recover(event.id, recovery, () =>
                order.push("consumed"),
              );
            } catch {
              rejected = true;
            }
            return {
              order,
              rejected,
              remaining: (await store.load({ readOnly: true })).length,
            };
          }
          const adoption = b.outbox.recover(event.id, recovery, () =>
            order.push("consumed"),
          );
          await saving;
          if (mode === "peer-accepted") {
            const peer = browserOutboxStorage(scope);
            await peer.load();
            await peer.save([
              { event, signed: event, recovery, delivery: "accepted" },
            ]);
            peer.close();
            resume();
            await adoption;
            return {
              order,
              delivery: (await store.load({ readOnly: true }))[0]?.delivery,
            };
          }
          // Dismissal must wait while adoption persists and consumes its source row.
          const dismissal = a.outbox
            .dismiss(event.id)
            .then(() => order.push("dismissed"));
          resume();
          await Promise.all([adoption, dismissal]);
          const after = await store.load({ readOnly: true });
          return { order, remaining: after.length };
        } finally {
          a.dispose();
          b.dispose();
          await purgeOutboxStorage(scope);
        }
      },
      { event, mode },
    );
    expect(result).toEqual(
      mode === "dismiss-first"
        ? { order: [], rejected: true, remaining: 0 }
        : mode === "peer-accepted"
          ? { order: ["consumed"], delivery: "accepted" }
          : { order: ["consumed", "dismissed"], remaining: 0 },
    );
  });
