import { useSyncExternalStore } from "react";
import { soloNavigationFor } from "../channel-navigation/solo-navigation";
import type { SoloChatWorkspace } from "../channel-navigation/solo-navigation-contract";
import type { ChannelWindow } from "../relay/contracts";
import type { RelaySession } from "../relay/session";

/** A chat is new until it has a message: its verified, complete history
 * holds only membership changes. History not yet known is not new. */
export function newChat(window: ChannelWindow | undefined) {
  return (
    window?.status === "ready" &&
    window.freshness === "verified" &&
    !window.refreshing &&
    !window.loadingOlder &&
    !window.hasMore &&
    !window.historyLimited &&
    !window.hasNewer &&
    window.rows.every((row) => !!row.membership)
  );
}

const noSubscription = () => () => {};
const noNavigation = () => undefined;

/** The workspace a region files its chat in, when the region offers one. */
export function useRegionWorkspace(
  session: RelaySession,
  channelId: string | undefined,
): SoloChatWorkspace | undefined {
  // Solo navigation publishes on every channel-list change. Without a chat
  // there is nothing to file, so skip the subscription and its renders.
  const reader = channelId ? soloNavigationFor(session) : undefined;
  const navigation = useSyncExternalStore(
    reader?.subscribe ?? noSubscription,
    reader?.snapshot ?? noNavigation,
  );
  const binding = navigation?.binding;
  const source = navigation?.regions.find((region) =>
    region.channels.some((channel) => channel.id === channelId),
  )?.source;
  if (!channelId || !binding || !source?.workspace) return undefined;
  try {
    return source.workspace(binding, channelId);
  } catch {
    // A broken optional source leaves the chat without the control.
    return undefined;
  }
}
