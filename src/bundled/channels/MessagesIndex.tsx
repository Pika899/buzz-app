import type { ReactNode } from "react";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useId,
  useCallback,
} from "react";
import { ConversationListVisibility } from "../../features/conversation/ConversationListToggle";
import { InboxSheet } from "../inbox/InboxSheet";
import { soloDraft } from "../../features/channel-navigation/routes";
import {
  messageCollectionOf,
  messagesSheetRoute,
  soloMessagesSheetRoute,
} from "./messages-sheet-route";
import type { ConversationHostServices } from "../../features/conversation/ConversationHost";
import type { ConversationExtensions } from "../../features/conversation/contracts";
import type { RelayData } from "../../features/relay/service";
import type { Navigation } from "../../features/navigation/controller";
import type { PageNavigation } from "../../features/navigation/service";
import { useChannelList, useRelayConnection } from "../../features/relay/react";
import { EmptyState } from "../../shared/design-system/ui/EmptyState";
import { ChatCircleIcon } from "../../shared/design-system/icons";
import styles from "./MessagesIndex.module.css";
import { useRailLayout } from "../../app/shell/rail-layout";
import { useRailPins, type RailEntry } from "../../app/shell/rail-pins";

/** One collection host for list pages, direct conversations, and Solo chats. */
export function MessagesIndex({
  relay,
  navigation,
  host,
  extensions,
  section,
  list,
  detail,
}: {
  relay: RelayData;
  navigator: Navigation;
  navigation?: PageNavigation | undefined;
  host: ConversationHostServices;
  extensions: ConversationExtensions;
  section?: "messages" | "solo" | undefined;
  list(section: string, navigator: Navigation): ReactNode;
  detail?: ReactNode;
}) {
  const connection = useRelayConnection(relay);
  const channels = useChannelList(connection.session.channels);
  const target = navigation?.target;
  const { layout } = useRailLayout(connection.scope ?? "disconnected");
  const { pins } = useRailPins(connection.scope ?? "disconnected");
  const sectionKey = "conversation-list-section";
  const fromList = useRef<
    { entryId: string; open: boolean; section: string } | undefined
  >(undefined);
  const selected =
    target?.kind === "conversation"
      ? channels.channels.find((channel) => channel.id === target.channelId)
      : undefined;
  const belongs = (entry: RailEntry) => {
    if (target?.kind !== "conversation") return false;
    const destination = entry.target;
    return destination.kind === "conversation"
      ? destination.channelId === target.channelId &&
          (!destination.threadRootId ||
            destination.threadRootId === target.threadRootId) &&
          (!destination.messageId || destination.messageId === target.messageId)
      : destination.kind === "person" &&
          selected?.channelType === "dm" &&
          selected.participants?.length === 1 &&
          selected.participants[0] === destination.pubkey;
  };
  const availableSections = new Map([
    ["messages", "Team"],
    ["solo", "Solo"],
    ["pins", "Pins"],
    ["agents", "Agents"],
    ["navigation", "Plugins"],
    ...layout.sections.map(({ id, title }) => [id, title] as const),
  ]);
  const savedSection =
    fromList.current?.entryId === navigation?.entryId
      ? fromList.current?.section
      : navigation?.position(sectionKey);
  const assignedSection = layout.placements.find(
    ({ section, entry }) => availableSections.has(section) && belongs(entry),
  )?.section;
  const collection =
    section ??
    messageCollectionOf(target) ??
    (typeof savedSection === "string" && availableSections.has(savedSection)
      ? savedSection
      : undefined) ??
    assignedSection ??
    (pins.some(belongs) ? "pins" : undefined) ??
    (selected?.channelType === "solo" ||
    (target?.kind === "page" && soloDraft(target.route?.params))
      ? "solo"
      : "messages");
  const title = availableSections.get(collection) ?? "Team";
  const positionKey = "conversation-list-open";
  const element = useRef<HTMLElement>(null);
  const controls = useId();
  const hasSelection =
    !!detail ||
    !!messagesSheetRoute.detail(target) ||
    messagesSheetRoute.composing(target);
  const [listOpen, setListOpen] = useState(!hasSelection);
  const [listMotion, setListMotion] = useState(false);
  const listNavigator = useMemo<Navigation>(
    () => ({
      ...host.navigation,
      open(target, options) {
        const wide =
          !!element.current &&
          element.current.clientWidth >=
            48 *
              parseFloat(getComputedStyle(document.documentElement).fontSize);
        const pending = host.navigation.open(target, options);
        fromList.current = {
          entryId: host.navigation.snapshot().entry.id,
          open: wide,
          section: collection,
        };
        return pending;
      },
    }),
    [host.navigation, collection],
  );
  useLayoutEffect(() => {
    if (!navigation) return;
    const saved = navigation.position(positionKey);
    const next =
      fromList.current?.entryId === navigation.entryId
        ? fromList.current.open
        : navigation.traversal && typeof saved === "boolean"
          ? saved
          : !hasSelection;
    if (fromList.current?.entryId === navigation.entryId)
      navigation.savePosition(sectionKey, fromList.current.section);
    fromList.current = undefined;
    setListMotion(false);
    setListOpen(next);
    navigation.savePosition(positionKey, next);
  }, [navigation, hasSelection]);
  const setOpen = useCallback(
    (open: boolean, animate = false) => {
      setListMotion(animate);
      setListOpen(open);
      navigation?.savePosition(positionKey, open);
    },
    [navigation],
  );
  const visibility = useMemo(
    () => ({
      open: listOpen,
      animate: listMotion,
      label: title,
      controls,
      setOpen,
    }),
    [listOpen, listMotion, title, controls, setOpen],
  );
  useEffect(() => {
    // Full conversations acknowledge their own admission, loading and failure.
    if (!detail) navigation?.complete({ status: "opened" });
  }, [navigation, detail]);
  return (
    <ConversationListVisibility value={visibility}>
      <section
        ref={element}
        className={styles.page}
        aria-label={
          collection === "messages" || collection === "solo"
            ? title
            : `${title} workspace`
        }
      >
        {connection.viewer && connection.scope ? (
          <InboxSheet
            key={`${connection.scope}:${connection.generation}`}
            id={collection}
            label={title}
            session={connection.session}
            scope={connection.scope}
            host={host}
            extensions={extensions}
            navigation={navigation}
            route={
              collection === "solo"
                ? soloMessagesSheetRoute
                : messagesSheetRoute
            }
            detail={detail}
            draftKind={collection === "solo" ? "solo" : "team"}
          >
            {() => list(collection, listNavigator)}
          </InboxSheet>
        ) : (
          <EmptyState
            icon={<ChatCircleIcon />}
            title={
              connection.status === "connecting"
                ? "Connecting…"
                : "Choose a community"
            }
            description="Your conversations appear here when connected."
          />
        )}
      </section>
    </ConversationListVisibility>
  );
}
