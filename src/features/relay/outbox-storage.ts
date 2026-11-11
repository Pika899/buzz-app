import type { OutboxRecovery, OutboxStorage, OutgoingEvent } from "./outbox";

function openDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("buzz-outbox-v2", 3);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("partitions"))
        db.createObjectStore("partitions");
      if (!db.objectStoreNames.contains("events"))
        db.createObjectStore("events", {
          keyPath: ["scope", "id"],
        }).createIndex("scope", "scope");
      if (!db.objectStoreNames.contains("retirements"))
        db.createObjectStore("retirements", {
          keyPath: ["scope", "id"],
        }).createIndex("scope", "scope");
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () =>
      reject(new Error("Close other Buzz windows to upgrade the outbox"));
  });
}

/** Drops one partition's journal, including its legacy record, after that
 * community's session is disposed: nothing left there can still be delivered. */
export async function purgeOutboxStorage(scope: string) {
  localStorage.removeItem(`buzz-outbox-v1:${scope}`);
  if (typeof indexedDB === "undefined") return;
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(
        ["events", "partitions", "retirements"],
        "readwrite",
        {
          durability: "strict",
        },
      );
      const events = tx.objectStore("events");
      const keys = events.index("scope").getAllKeys(IDBKeyRange.only(scope));
      keys.onsuccess = () => {
        for (const key of keys.result) events.delete(key);
      };
      const retirements = tx.objectStore("retirements");
      const retiredKeys = retirements
        .index("scope")
        .getAllKeys(IDBKeyRange.only(scope));
      retiredKeys.onsuccess = () => {
        for (const key of retiredKeys.result) retirements.delete(key);
      };
      tx.objectStore("partitions").delete(scope);
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error ?? new Error("Outbox purge aborted"));
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

/** Incremental asynchronous journal, atomically partitioned by relay and viewer. */
export function browserOutboxStorage(scope: string): OutboxStorage {
  let database: Promise<IDBDatabase> | undefined;
  let persisted = new Map<string, OutgoingEvent>();
  let ownershipRevision = 0;
  const forgotten = new Map<string, number>();
  const open = () => (database ??= openDatabase());
  return {
    async lock(id, run) {
      if (!navigator.locks) throw new Error("Window ownership is unavailable.");
      return navigator.locks.request(`buzz-outbox:${scope}:${id}`, run);
    },
    forget(id) {
      forgotten.set(id, ++ownershipRevision);
      persisted.delete(id);
    },
    async retire(id, recovery) {
      const db = await open();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(
          ["events", "retirements", "partitions"],
          "readwrite",
          {
            durability: "strict",
          },
        );
        const events = tx.objectStore("events");
        const retirements = tx.objectStore("retirements");
        const record = events.get([scope, id]);
        const marker = retirements.get([scope, id]);
        const legacy = tx.objectStore("partitions").get(scope);
        legacy.onsuccess = () => {
          let rows: readonly OutgoingEvent[];
          try {
            rows =
              legacy.result === true
                ? []
                : (legacy.result ??
                  JSON.parse(
                    localStorage.getItem(`buzz-outbox-v1:${scope}`) ?? "[]",
                  ));
          } catch (error) {
            reject(error);
            tx.abort();
            return;
          }
          const item: OutgoingEvent | undefined =
            record.result?.operation ?? rows.find((row) => row.event.id === id);
          const expected: OutboxRecovery | undefined =
            marker.result?.recovery ?? item?.recovery;
          if (
            (item && !item.guarded) ||
            (expected &&
              (expected.key !== recovery.key ||
                expected.value !== recovery.value)) ||
            (item && !expected)
          ) {
            reject(new Error("Outbox retirement does not match the receipt"));
            tx.abort();
            return;
          }
          retirements.put({ scope, id, recovery });
          events.delete([scope, id]);
        };
        tx.oncomplete = () => {
          persisted.delete(id);
          resolve();
        };
        tx.onabort = () =>
          reject(tx.error ?? new Error("Outbox retirement aborted"));
        tx.onerror = () => reject(tx.error);
      });
    },
    async load(options) {
      const db = await open();
      let migrated = false;
      const records = await new Promise<readonly OutgoingEvent[]>(
        (resolve, reject) => {
          const tx = db.transaction(["events", "partitions", "retirements"]);
          const entries = tx
            .objectStore("events")
            .index("scope")
            .getAll(IDBKeyRange.only(scope));
          const legacy = tx.objectStore("partitions").get(scope);
          const retired = tx
            .objectStore("retirements")
            .index("scope")
            .getAllKeys(IDBKeyRange.only(scope));
          tx.oncomplete = () => {
            try {
              migrated = legacy.result === true;
              const values = entries.result.map(
                (entry: { operation: OutgoingEvent }) => entry.operation,
              );
              // The marker distinguishes a migrated empty journal from an un-migrated one.
              const records: readonly OutgoingEvent[] =
                values.length || legacy.result === true
                  ? values
                  : (legacy.result ??
                    JSON.parse(
                      localStorage.getItem(`buzz-outbox-v1:${scope}`) ?? "[]",
                    ));
              const ids = new Set(
                retired.result.map((key) => (key as [string, string])[1]),
              );
              resolve(records.filter((item) => !ids.has(item.event.id)));
            } catch (error) {
              reject(error);
            }
          };
          tx.onabort = () => reject(tx.error);
          tx.onerror = () => reject(tx.error);
        },
      );
      // A first save migrates legacy records into the per-event store.
      if (!options?.readOnly)
        persisted = migrated
          ? new Map(records.map((item) => [item.event.id, item]))
          : new Map();
      return records;
    },
    async save(operations, options) {
      const revision = ownershipRevision;
      const db = await open();
      const next = new Map(operations.map((item) => [item.event.id, item]));
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(
          ["events", "partitions", "retirements"],
          "readwrite",
          {
            durability: "strict",
          },
        );
        const events = tx.objectStore("events");
        const retirements = tx.objectStore("retirements");
        for (const [id, operation] of next) {
          const old = persisted.get(id);
          if (
            id !== options?.force &&
            old &&
            old.delivery === operation.delivery &&
            old.error === operation.error &&
            old.refused === operation.refused &&
            old.acknowledged === operation.acknowledged &&
            old.signed?.id === operation.signed?.id &&
            old.recovery?.key === operation.recovery?.key &&
            old.recovery?.value === operation.recovery?.value &&
            old.guarded === operation.guarded
          )
            continue;
          const retired = retirements.get([scope, id]);
          retired.onsuccess = () => {
            if (retired.result) next.delete(id);
            else events.put({ scope, id, operation });
          };
        }
        for (const id of persisted.keys())
          if (!next.has(id)) events.delete([scope, id]);
        tx.objectStore("partitions").put(true, scope);
        tx.oncomplete = () => {
          // A read can relinquish an ID while this transaction is pending.
          // Do not let completion reclaim deletion ownership of that ID.
          persisted = new Map(
            [...next].filter(([id]) => (forgotten.get(id) ?? 0) <= revision),
          );
          resolve();
        };
        tx.onabort = () =>
          reject(tx.error ?? new Error("Outbox transaction aborted"));
        tx.onerror = () => reject(tx.error);
      });
    },
    close() {
      void database?.then(
        (db) => db.close(),
        () => {},
      );
    },
  };
}
