import {
  lifecycleRecord,
  exactLifecycleTag,
} from "../relay/channel-lifecycle-protocol";
import type { RelaySession } from "../relay/session";
import type { HuddleDestination } from "./bridge";

/** Explicit hangup only; failed joins and lost connections remain relay-owned. */
export async function endLastHumanHuddle(
  session: RelaySession,
  destination: HuddleDestination,
  room: string,
  admissions: readonly string[],
  active: () => boolean,
) {
  const { viewer, channelId } = destination;
  // Native preserves peer indices, unlike the deduplicated participant UI.
  if (admissions.filter((key) => key === viewer).length !== 1 || !active())
    return;
  const { relayAuthor, outbox } = session;
  if (
    !session.snapshotRead ||
    !relayAuthor ||
    !outbox?.supports(48103) ||
    !session.channelLifecycle.available
  )
    return;
  const signal = AbortSignal.timeout(10_000);
  const current = () => !signal.aborted && active();
  const records = await session.snapshotRead(
    [
      {
        kinds: [39000, 39002],
        authors: [relayAuthor],
        "#d": [room],
        limit: 2,
        consistency: "strong",
      },
    ],
    { signal },
  );
  if (!current()) return;
  const metadata = lifecycleRecord(records, 39000, room, relayAuthor);
  const roster = lifecycleRecord(records, 39002, room, relayAuthor);
  // The protocol allows only the room's creator (or relay) to announce its end.
  if (
    !metadata ||
    exactLifecycleTag(metadata, "archived") === "true" ||
    exactLifecycleTag(metadata, "P") !== viewer ||
    !roster
  )
    return;
  const members = roster.tags.filter(([tag]) => tag === "p");
  if (
    members.some(
      (tag) => tag.length > 4 || !/^[0-9a-f]{64}$/.test(tag[1] ?? ""),
    )
  )
    return;
  const humans = members.filter((tag) => tag[3] !== "bot");
  if (humans.length !== 1 || humans[0]?.[1] !== viewer) return;
  // A peer missing from membership evidence may be a newly admitted human.
  if (admissions.some((key) => !members.some((tag) => tag[1] === key))) return;
  const id = outbox.send(
    {
      kind: 48103,
      tags: [["h", channelId]],
      content: JSON.stringify({ ephemeral_channel_id: room }),
    },
    undefined,
    current,
  );
  await session.channelWrites.delivered(id, current, false, false);
  try {
    await session.channelLifecycle.run("archive", room, signal, current);
  } catch (error) {
    if (!active()) return;
    if (signal.aborted) throw error;
    // Closing audio can let relay cleanup win the same archive operation.
    const records = await session.snapshotRead(
      [
        {
          kinds: [39000],
          authors: [relayAuthor],
          "#d": [room],
          limit: 1,
          consistency: "strong",
        },
      ],
      { signal },
    );
    const metadata = lifecycleRecord(records, 39000, room, relayAuthor);
    if (!metadata || exactLifecycleTag(metadata, "archived") !== "true")
      throw error;
  }
}
