import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentProps,
  type ReactNode,
} from "react";
import { AvatarStack } from "../../shared/design-system/ui/AvatarStack";
import { flushSync } from "react-dom";
import type { RelaySession } from "../../features/relay/session";
import type { ChannelSummary } from "../../features/relay/contracts";
import { ConversationRow } from "../../features/messages/ConversationRow";
import { useUnreadState } from "../../bundled/channels/UnreadBadge";
import type { NavigationScope } from "../../features/navigation/targets";
import type { NavigationOpenOptions } from "../../features/navigation/controller";
import { targetKey } from "../../features/navigation/targets";
import type { Navigation } from "../../features/navigation/controller";
import type { RegisteredPage } from "../../features/pages/service";
import { useAgentChoices } from "../../features/agents/use-choices";
import { AgentAvatarArtworkProvider } from "../../features/agents/AgentAvatarArtworkProvider";
import { canMessageAgent } from "../../features/agents/choices";
import { archiveHides } from "../../features/relay/identity-archives";
import { readSearchUsage } from "../../features/search/usage";
import { avatarMedia } from "../../shared/avatar-source";
import { ChannelAvatar } from "../../features/channels/ChannelAvatar";
import { dmLabel } from "../../bundled/inbox/dm-label";
import { useIdentityNames } from "../../features/identity-names/react";
import { useSavedHiddenDmIds } from "../../bundled/channels/useHiddenDms";
import { soloDraftTarget } from "../../features/channel-navigation/routes";
import {
  sidebarSectionTarget,
  isSidebarSectionRoute,
} from "../../features/channel-navigation/sidebar-section-route";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import { NavigationSection } from "../../shared/design-system/ui/NavigationSection";
import { SidebarNavigation } from "../../shared/design-system/ui/SidebarNavigation";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { Input } from "../../shared/design-system/ui/Input";
import { Tooltip } from "../../shared/design-system/ui/Tooltip";
import {
  ArrowRightIcon,
  Filter2Icon,
  ChatCircleIcon,
  PinIcon,
  PlusIcon,
  StorefrontIcon,
  RobotIcon,
  UserIcon,
} from "../../shared/design-system/icons";
import { useRailLayout } from "./rail-layout";
import { RailArrangement, RailGroup, RailSourceRow } from "./RailArrangement";
import { ContributedRailSections } from "../../features/channel-navigation/ContributedRailSections";
import type { SidebarSections } from "../../features/channel-navigation/sidebar-sections-service";
import { PageNavigation } from "./PageNavigation";
import { RailConversationList } from "./RailConversationList";
import { useRailPins, type RailEntry } from "./rail-pins";
import { useChannelNavigation } from "../../features/channel-navigation/ChannelNavigationState";
import {
  MenuItem,
  MenuRoot,
  MenuTrigger,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuCheckboxItem,
  MenuGroupLabel,
  MenuSeparator,
} from "../../shared/design-system/ui/Menu";
import styles from "./RailNavigation.module.css";
import { preferredRailAgents } from "./rail-activity";
import {
  ConversationList,
  CollectionFilters,
  conversationViews,
  includeMessagesChannel,
  useActivityView,
} from "../../features/conversation/ConversationList";

export function RailNavigation({
  session,
  scope,
  navigator,
  pages,
  selected,
  onSelect,
  creationAction,
  sidebarSections,
  pageSection,
  compact = false,
}: {
  session: RelaySession;
  scope: NavigationScope;
  navigator: Navigation;
  pages: readonly RegisteredPage[];
  selected: string;
  onSelect(
    key: string,
    options?: Pick<NavigationOpenOptions, "focus"> & { section?: string },
  ): void;
  creationAction?: ReactNode;
  sidebarSections?: SidebarSections | undefined;
  pageSection?: string | undefined;
  compact?: boolean;
}) {
  const partition = `${scope.communityOrigin}:${scope.viewer}`;
  const contributed = useSyncExternalStore(
    sidebarSections?.subscribe ?? noSubscription,
    sidebarSections?.snapshot ?? noSections,
  );
  const channelNavigation = useChannelNavigation();
  const closeMuteMenu = useRef<(() => void) | undefined>(undefined);
  const muteRecovery =
    channelNavigation?.session === session
      ? channelNavigation.muteRecovery
      : undefined;
  useEffect(() => {
    if (!muteRecovery || pageSection) return;
    const recovery = {
      closeMenu: () => closeMuteMenu.current?.(),
      focus: (channelId: string) =>
        document
          .querySelector<HTMLElement>(
            `#shell-rail [data-rail-channel="${CSS.escape(channelId)}"]`,
          )
          ?.focus(),
    };
    muteRecovery.current = recovery;
    return () => {
      if (muteRecovery.current === recovery) muteRecovery.current = undefined;
    };
  }, [muteRecovery, pageSection]);
  const preferences = useSyncExternalStore(
    session.sidebarPreferences.subscribe,
    session.sidebarPreferences.snapshot,
  );
  const resolveName = useIdentityNames(session.names);
  const { layout: railLayout, reset: resetPlacement } =
    useRailLayout(partition);
  const [messageView, setMessageView] = useActivityView(partition);
  const messageSort = messageView.sort ?? "recent";
  const messageFilter = messageView.filter;
  const setMessageSort = (sort: "recent" | "alpha") =>
    setMessageView({ ...messageView, sort });
  const setMessageFilter = (filter: typeof messageFilter) =>
    setMessageView({ ...messageView, filter });
  const { pins, setPinned } = useRailPins(partition);
  const list = useSyncExternalStore(
    session.channels.subscribeList,
    session.channels.list,
  );
  const profiles = useSyncExternalStore(
    session.profiles.subscribe,
    session.profiles.snapshot,
  );
  const agents = useAgentChoices(session, true, true);
  const archives = useSyncExternalStore(
    session.archives.subscribe,
    session.archives.snapshot,
  );
  const navigation = useSyncExternalStore(
    navigator.subscribe,
    navigator.snapshot,
  );
  const sectionRoute =
    navigation.entry.target.kind === "page"
      ? navigation.entry.target.route?.params
      : undefined;
  const selectedSection = isSidebarSectionRoute(sectionRoute)
    ? sectionRoute.section
    : undefined;
  const [picker, setPicker] = useState(false);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string>();
  const [opening, setOpening] = useState<string>();
  const pending = useRef<AbortController>(undefined);
  const pinTrigger = useRef<HTMLButtonElement>(null);
  const hidden = useSavedHiddenDmIds(partition);
  // biome-ignore lint/correctness/useExhaustiveDependencies: A new visit cancels a previous person-open attempt.
  useEffect(() => {
    pending.current?.abort();
    pending.current = undefined;
    setOpening(undefined);
  }, [navigation.attempt.id]);
  useEffect(() => () => pending.current?.abort(), []);

  const channels = useMemo(
    () =>
      list.channels.filter(
        (channel) =>
          !channel.archived && !channel.huddle && !channel.metadataPending,
      ),
    [list.channels],
  );
  const channelEntries = useMemo(
    (): RailEntry[] =>
      channels.map((channel) => {
        const dm = channel.channelType === "dm";
        const other = dm ? channel.participants?.[0] : undefined;
        return {
          id: `channel:${channel.id}`,
          label: dm
            ? dmLabel(channel.participants, profiles, resolveName, channel.name)
            : channel.name,
          kind: dm
            ? "person"
            : channel.channelType === "solo"
              ? "chat"
              : "channel",
          picture: other ? profiles.get(other)?.picture : undefined,
          target: {
            version: 1,
            kind: "conversation",
            scope,
            channelId: channel.id,
          },
        };
      }),
    [channels, profiles, resolveName, scope],
  );
  const agentEntries = useMemo(
    (): RailEntry[] =>
      agents.selectable.filter(canMessageAgent).map((agent) => ({
        id: `agent:${agent.pubkey}`,
        label: agent.managedName ?? agent.name,
        picture: agent.avatar,
        kind: "agent",
        target: { kind: "person", pubkey: agent.pubkey },
      })),
    [agents.selectable],
  );
  const people = useMemo((): RailEntry[] => {
    void archives;
    // Only pinned people need labels while the picker is closed.
    const pinnedPeople = new Set(pins.map((pin) => pin.id));
    const knownAgents = new Set(agents.identities.map((agent) => agent.pubkey));
    return (
      picker
        ? [...profiles]
        : pins.flatMap((pin) => {
            if (pin.target.kind !== "person") return [];
            const profile = profiles.get(pin.target.pubkey);
            return profile ? [[pin.target.pubkey, profile] as const] : [];
          })
    )
      .filter(
        ([key, profile]) =>
          (picker || pinnedPeople.has(`person:${key}`)) &&
          key !== scope.viewer &&
          !profile.isAgent &&
          !profile.nameIsFallback &&
          !knownAgents.has(key) &&
          !archiveHides(session.archives, key, scope.viewer),
      )
      .map(([pubkey, profile]) => ({
        id: `person:${pubkey}`,
        label: resolveName(pubkey, profile.name),
        kind: "person",
        picture: profile.picture,
        target: { kind: "person", pubkey },
      }));
  }, [
    picker,
    pins,
    profiles,
    agents.identities,
    session.archives,
    archives,
    scope.viewer,
    resolveName,
  ]);
  const pageEntries = useMemo(
    (): RailEntry[] =>
      pages.map((page) => ({
        id: page.key,
        label: page.title === "Channels" ? "Team" : page.title,
        kind: "page",
        target: {
          version: 1,
          kind: "page",
          pluginId: page.pluginId,
          pageId: page.id,
          scope,
        },
      })),
    [pages, scope],
  );
  const entries = useMemo(
    () => [...channelEntries, ...agentEntries, ...people, ...pageEntries],
    [channelEntries, agentEntries, people, pageEntries],
  );
  const byId = useMemo(
    () => new Map(entries.map((entry) => [entry.id, entry])),
    [entries],
  );
  const pinned = new Set(pins.map((pin) => pin.id));
  const togglePin = (entry: RailEntry, nextPinned = !pinned.has(entry.id)) => {
    const saved = resetPlacement(entry.id) && setPinned(entry, nextPinned);
    setError(
      saved ? undefined : "Couldn’t save pins on this device. Try again.",
    );
    return saved;
  };
  const open = async (entry: RailEntry) => {
    setError(undefined);
    if (entry.target.kind !== "person") {
      void navigator.open(entry.target);
      return;
    }
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    setOpening(entry.id);
    try {
      const pubkey = entry.target.pubkey;
      const existing = channels.find(
        (channel) =>
          channel.channelType === "dm" &&
          channel.participants?.length === 1 &&
          channel.participants[0] === pubkey,
      );
      if (
        entry.kind === "agent" &&
        !existing &&
        !session.agentChoices
          .snapshot()
          .selectable.some(
            (agent) => agent.pubkey === pubkey && canMessageAgent(agent),
          )
      )
        throw new Error(
          "This agent is not ready to message in this community.",
        );
      // The former sidebar loaded this projection. With one rail, read it only
      // when a person is opened; its owner retains retry and cancellation rules.
      if (
        existing &&
        session.directMessages.available &&
        session.channelLifecycle.snapshot().status !== "ready"
      )
        await session.channelLifecycle.refreshVisibility(controller.signal);
      const currentVisibility = session.channelLifecycle.snapshot();
      const visible =
        existing &&
        (!session.directMessages.available ||
          (currentVisibility.status === "ready" &&
            !currentVisibility.hidden.includes(existing.id) &&
            !hidden.has(existing.id)));
      const channelId = visible
        ? existing.id
        : await session.directMessages.open([pubkey], controller.signal);
      if (!controller.signal.aborted)
        await navigator.open({
          version: 1,
          kind: "conversation",
          scope,
          channelId,
        });
    } catch (reason) {
      if (!controller.signal.aborted)
        setError(
          reason instanceof Error
            ? reason.message
            : "Couldn’t open this conversation. Try again.",
        );
    } finally {
      if (pending.current === controller) {
        pending.current = undefined;
        setOpening(undefined);
      }
    }
  };
  const isSelected = (entry: RailEntry) => {
    const target = navigation.entry.target;
    if (entry.target.kind === "person") {
      const pubkey = entry.target.pubkey;
      return (
        target.kind === "conversation" &&
        channels.some(
          (channel) =>
            channel.id === target.channelId &&
            channel.channelType === "dm" &&
            channel.participants?.length === 1 &&
            channel.participants[0] === pubkey,
        )
      );
    }
    return entry.target.kind === "conversation" &&
      target.kind === "conversation"
      ? entry.target.channelId === target.channelId &&
          (!entry.target.messageId ||
            entry.target.messageId === target.messageId)
      : targetKey(entry.target) === targetKey(target);
  };
  const avatarArtwork = (entry: RailEntry, avatarOnly = false) => {
    const channelId =
      entry.target.kind === "conversation" ? entry.target.channelId : undefined;
    const channel = channelId
      ? channels.find((item) => item.id === channelId)
      : undefined;
    const participants =
      channel?.channelType === "dm"
        ? [...new Set(channel.participants ?? [])].filter(
            (person) => person !== session.viewer,
          )
        : [];
    if (avatarOnly && participants.length > 1)
      return (
        <AvatarStack
          size="cluster"
          items={participants.slice(0, 3).map((person) => ({
            id: person,
            name: resolveName(person, profiles.get(person)?.name ?? "Member"),
            src: avatarMedia(profiles.get(person)?.picture, session.media),
            shape: profiles.get(person)?.isAgent ? "squircle" : "circle",
          }))}
        />
      );
    if (entry.kind === "person" || entry.kind === "agent")
      return (
        <Avatar
          size={avatarOnly ? "fill" : "compact"}
          shape={entry.kind === "agent" ? "squircle" : "circle"}
          src={avatarMedia(entry.picture, session.media)}
          alt=""
          fallback={entry.label}
        />
      );
    if (entry.kind === "chat" && !avatarOnly) {
      const agent = agents.identities.find((agent) =>
        channel?.members?.includes(agent.pubkey),
      );
      return (
        <Avatar
          size="compact"
          shape="squircle"
          src={avatarMedia(
            agent?.avatar ?? (agent && profiles.get(agent.pubkey)?.picture),
            session.media,
          )}
          alt=""
          fallback={agent?.name ?? entry.label}
        />
      );
    }
    const Icon = entry.kind === "chat" ? ChatCircleIcon : StorefrontIcon;
    return entry.kind === "channel" ? (
      <ChannelAvatar
        size={avatarOnly ? "fill" : "compact"}
        name={entry.label}
      />
    ) : avatarOnly ? (
      <Avatar
        size="fill"
        alt=""
        fallback={entry.label}
        src={avatarMedia(
          agentEntries.find(
            (agent) =>
              entry.kind === "chat" &&
              agent.target.kind === "person" &&
              channel?.members?.includes(agent.target.pubkey),
          )?.picture,
          session.media,
        )}
        fallbackContent={entry.kind === "page" ? <Icon size={24} /> : undefined}
      />
    ) : (
      <Icon size={18} />
    );
  };
  const artwork = (entry: RailEntry, avatarOnly = false) => {
    const avatar = avatarArtwork(entry, avatarOnly);
    if (!avatarOnly) return avatar;
    return (
      <span className={styles.pinArtwork}>
        {isSelected(entry) && (
          <span
            className={styles.pinSelection}
            data-channel={entry.kind === "channel" || undefined}
            data-agent={entry.kind === "agent" || undefined}
            aria-hidden="true"
          >
            <span className={styles.pinSelectionArtwork}>{avatar}</span>
          </span>
        )}
        {avatar}
      </span>
    );
  };
  const row = (entry: RailEntry, avatarOnly = false) => {
    const target = entry.target;
    const channel =
      target.kind === "conversation"
        ? channels.find((channel) => channel.id === target.channelId)
        : target.kind === "person"
          ? channels.find(
              (channel) =>
                channel.channelType === "dm" &&
                channel.participants?.length === 1 &&
                channel.participants[0] === target.pubkey,
            )
          : undefined;
    const label = (
      <span className={styles.rowLabel}>
        <span>{entry.label}</span>
      </span>
    );
    const props = {
      title: avatarOnly ? undefined : entry.label,
      "aria-label": entry.label,
      selected: isSelected(entry),
      disabled: opening === entry.id,
      onClick: () => void open(entry),
    };
    const control = channel ? (
      <RailConversationItem
        key={entry.id}
        {...props}
        data-rail-channel={channel.id}
        session={session}
        channel={channel}
        avatar={artwork(entry, avatarOnly)}
        avatarOnly={avatarOnly}
        place={label}
      />
    ) : (
      <NavigationItem
        key={entry.id}
        {...props}
        icon={artwork(entry, avatarOnly)}
        variant={avatarOnly ? "avatar" : "row"}
        label={label}
      />
    );
    return avatarOnly ? (
      <Tooltip content={entry.label} hint="dock">
        {control}
      </Tooltip>
    ) : (
      control
    );
  };

  const sourceRow = (entry: RailEntry, section: string) => (
    <RailSourceRow key={entry.id} section={section} entry={entry}>
      {row(
        entry,
        (section === "pins" || section === "agents") && pageSection !== section,
      )}
    </RailSourceRow>
  );

  const soloChats = useMemo(
    () =>
      channels
        .filter((channel) => channel.channelType === "solo")
        .sort(
          (a, b) =>
            (b.lastActivityAt ?? b.createdAt ?? b.updatedAt ?? 0) -
              (a.lastActivityAt ?? a.createdAt ?? a.updatedAt ?? 0) ||
            a.id.localeCompare(b.id),
        ),
    [channels],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: a visit records fresh usage.
  const topAgents = useMemo(
    () =>
      preferredRailAgents(agentEntries, channels, readSearchUsage(partition)),
    [agentEntries, channels, partition, navigation.attempt.id],
  );
  const plugins = pages.filter(
    (page) =>
      page.primary &&
      ![
        "buzz.channels/channels",
        "buzz.inbox/inbox",
        "buzz.agents/agents",
      ].includes(page.key),
  );
  const current = entries.find(
    (entry) =>
      entry.target.kind !== "person" &&
      targetKey(entry.target) === targetKey(navigation.entry.target),
  ) ?? {
    id: `view:${targetKey(navigation.entry.target)}`,
    label: pages.find((page) => page.key === selected)?.title ?? "Current view",
    kind: "page" as const,
    target: navigation.entry.target,
  };
  const sortMessages = (
    a: RailEntry,
    b: RailEntry,
    order: ReadonlyMap<string, number>,
  ) =>
    (order.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
      (order.get(b.id) ?? Number.MAX_SAFE_INTEGER) ||
    a.label.localeCompare(b.label) ||
    a.id.localeCompare(b.id);
  const matches = (picker ? entries : [])
    .filter((entry) =>
      `${entry.label} ${entry.kind}`
        .toLowerCase()
        .includes(query.trim().toLowerCase()),
    )
    .slice(0, 60);

  const messageCard = (
    children: ReactNode,
    order: ReadonlyMap<string, number>,
  ) => (
    <RailGroup
      id="messages"
      title="Team"
      rowsLabel="Recent conversations"
      pageContent={sectionPage}
      sortEntries={(a, b) => sortMessages(a, b, order)}
      action={
        <>
          <MenuRoot>
            <MenuTrigger
              render={
                <IconButton
                  size="sm"
                  variant="ghost"
                  aria-label="Filter and sort Team card"
                  title="Filter and sort Team card"
                  icon={<Filter2Icon size={16} strokeWidth={2} />}
                />
              }
            />
            <MenuPopup align="end" size="compact">
              <MenuRadioGroup
                aria-label="Team view"
                value={messageFilter}
                onValueChange={(value) => {
                  const choice = conversationViews.find(
                    (item) => item.value === value,
                  );
                  if (choice) setMessageFilter(choice.value);
                }}
              >
                <MenuGroupLabel>Show</MenuGroupLabel>
                {conversationViews.map(({ value, label }) => (
                  <MenuRadioItem key={value} value={value} closeOnClick>
                    {label}
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
              <MenuSeparator />
              <MenuCheckboxItem
                checked={messageView.unread}
                onCheckedChange={(unread) =>
                  setMessageView({ ...messageView, unread })
                }
              >
                Unread only
              </MenuCheckboxItem>
              <MenuSeparator />
              <MenuRadioGroup
                aria-label="Team sort order"
                value={messageSort}
                onValueChange={(value) => {
                  if (value === "recent" || value === "alpha")
                    setMessageSort(value);
                }}
              >
                <MenuGroupLabel>Sort</MenuGroupLabel>
                <MenuRadioItem value="recent" closeOnClick>
                  Recent activity
                </MenuRadioItem>
                <MenuRadioItem value="alpha" closeOnClick>
                  A–Z
                </MenuRadioItem>
              </MenuRadioGroup>
            </MenuPopup>
          </MenuRoot>
          {creationAction}
        </>
      }
      footer={
        <NavigationItem
          label="View more"
          data-rail-view-more=""
          aria-label="View more team"
          icon={<ArrowRightIcon size={18} />}
          selected={
            navigation.entry.target.kind === "page" &&
            !isSidebarSectionRoute(navigation.entry.target.route?.params) &&
            selected === "buzz.channels/channels"
          }
          onClick={() => onSelect("buzz.channels/channels")}
        />
      }
    >
      {children}
    </RailGroup>
  );
  let sectionPage: ReactNode;
  if (pageSection === "messages" || pageSection === "solo") {
    const activeGroups = new Set([
      "navigation",
      "pins",
      "messages",
      "solo",
      "agents",
      ...contributed.map((section) => section.key),
      ...railLayout.sections.map((section) => section.id),
    ]);
    const source = (
      pageSection === "solo"
        ? soloChats.map((channel) => channel.id)
        : channels.map((channel) => channel.id)
    ).flatMap((id) => {
      const entry = byId.get(`channel:${id}`);
      return entry &&
        !railLayout.placements.some(
          (placed) =>
            placed.entry.id === entry.id && activeGroups.has(placed.section),
        )
        ? [entry]
        : [];
    });
    const placed = railLayout.placements
      .filter((item) => item.section === pageSection)
      .map(({ entry }) => byId.get(entry.id) ?? entry);
    sectionPage = (
      <RailConversationList
        section={pageSection}
        entries={[...source, ...placed]}
        session={session}
        scope={scope}
        navigator={navigator}
        target={navigation.entry.target}
        renderOther={(entry) => row(entry)}
      />
    );
  }
  return (
    <>
      <RailArrangement
        key={partition}
        partition={partition}
        renderSectionList={(id, title, entries, action) => (
          <RailConversationList
            section={id}
            title={title}
            heading={
              <CollectionFilters title={title} actions={action}>
                {null}
              </CollectionFilters>
            }
            entries={entries}
            session={session}
            scope={scope}
            navigator={navigator}
            target={navigation.entry.target}
            renderOther={(entry) => row(entry)}
          />
        )}
        pageSection={pageSection}
        compact={compact}
        selectedSection={selectedSection}
        openSection={(id) =>
          void navigator.open(sidebarSectionTarget(scope, id))
        }
        isPinned={(entry) => pinned.has(entry.id)}
        onTogglePin={(entry, nextPinned) => {
          if (nextPinned) {
            togglePin(entry, true);
            return;
          }
          // Remove the row and its menu before restoring focus to the rail.
          if (flushSync(() => togglePin(entry, false)))
            (
              pinTrigger.current ?? document.getElementById("main-content")
            )?.focus();
        }}
        renderEntry={(entry, section) => {
          if (section === "pins" || section === "agents")
            return row(byId.get(entry.id) ?? entry, pageSection !== section);
          const contribution = contributed.find((section) =>
            entry.id.startsWith(`contributed:${section.key}:`),
          );
          if (contribution && sidebarSections)
            return (
              <ContributedRailSections
                registry={sidebarSections}
                navigator={navigator}
                partition={partition}
                only={contribution.key}
                rowId={entry.id.slice(
                  `contributed:${contribution.key}:`.length,
                )}
                fallbackRow={row(entry)}
                renderSection={({ children }) => children}
              />
            );
          const page = pages.find((page) => page.key === entry.id);
          return page ? (
            <PageNavigation
              pages={[page]}
              selected={selected}
              onSelect={onSelect}
            />
          ) : (
            row(byId.get(entry.id) ?? entry)
          );
        }}
        renderRowActions={(entry, close, focus) => {
          if (
            channelNavigation?.session !== session ||
            !session.sidebarPreferences.muteWritable ||
            !preferences.data
          )
            return null;
          const destination = entry.target;
          const channel =
            destination.kind === "conversation"
              ? channels.find((channel) => channel.id === destination.channelId)
              : undefined;
          if (!channel) return null;
          const intent = channelNavigation.mute.intents.get(channel.id);
          const muted = intent?.pending
            ? intent.muted
            : preferences.data.muted.includes(channel.id);
          return (
            <MenuItem
              disabled={intent?.pending}
              onClick={() => {
                closeMuteMenu.current = close;
                channelNavigation.mute.change(channel.id, channel.name, !muted);
                close();
                focus();
              }}
            >
              {muted ? "Unmute" : "Mute"}
            </MenuItem>
          );
        }}
        sections={[
          {
            id: "navigation",
            title: "Plugins",
            icon: <StorefrontIcon size={22} />,
            content: (
              <RailGroup
                id="navigation"
                title="Plugins"
                unlimited
                trailingEntryId={pluginCatalog.id}
              >
                {[
                  ...pages.filter((page) => page.key === "buzz.inbox/inbox"),
                  ...plugins,
                ].map((page) => {
                  const entry = byId.get(page.key);
                  return (
                    entry && (
                      <RailSourceRow
                        key={page.key}
                        section="navigation"
                        entry={entry}
                      >
                        <PageNavigation
                          pages={[page]}
                          selected={selected}
                          onSelect={onSelect}
                          previews
                        />
                      </RailSourceRow>
                    )
                  );
                })}
                <RailSourceRow section="navigation" entry={pluginCatalog}>
                  <NavigationItem
                    label="View more"
                    data-rail-view-more=""
                    aria-label="View all plugins"
                    icon={<ArrowRightIcon size={18} />}
                    onClick={() => onSelect("settings", { section: "plugins" })}
                  />
                </RailSourceRow>
              </RailGroup>
            ),
          },
          {
            id: "pins",
            title: "Pins",
            icon: <PinIcon size={22} />,
            content: (
              <RailGroup
                id="pins"
                title="Pins"
                action={
                  <IconButton
                    size="sm"
                    variant="ghost"
                    aria-label="Add pin"
                    ref={pinTrigger}
                    icon={<PlusIcon size={16} strokeWidth={2} />}
                    onClick={() => {
                      setQuery("");
                      setPicker(true);
                    }}
                  />
                }
              >
                {pins.map((pin) => sourceRow(byId.get(pin.id) ?? pin, "pins"))}
                {!pins.length &&
                  !railLayout.placements.some(
                    (item) => item.section === "pins",
                  ) && (
                    <NavigationItem
                      label="Pin a chat, person, or channel"
                      icon={<PinIcon size={18} />}
                      onClick={() => {
                        setQuery("");
                        setPicker(true);
                      }}
                    />
                  )}
              </RailGroup>
            ),
          },
          {
            id: "messages",
            title: "Team",
            icon: <ChatCircleIcon size={22} />,
            content: (
              <ConversationList
                session={session}
                navigator={navigator}
                scope={scope}
                target={navigation.entry.target}
                view={messageView}
                includeChannel={(channel) =>
                  includeMessagesChannel(channel, messageView)
                }
                renderEntries={(items) => {
                  const filtered = items.flatMap((item) => {
                    const source = byId.get(`channel:${item.target.channelId}`);
                    return source
                      ? [
                          {
                            ...source,
                            id: item.key.startsWith("e:")
                              ? `activity:${item.key}`
                              : source.id,
                            label: item.label,
                            target: item.target,
                            at: item.at,
                          },
                        ]
                      : [];
                  });
                  return messageCard(
                    [
                      ...filtered.map((entry) => sourceRow(entry, "messages")),
                      !filtered.length && (
                        <p key="empty" className={styles.note}>
                          No matching conversations.
                        </p>
                      ),
                    ],
                    new Map(filtered.map((entry, index) => [entry.id, index])),
                  );
                }}
              />
            ),
          },
          {
            id: "solo",
            title: "Solo",
            icon: <UserIcon size={22} />,
            content: (
              <RailGroup
                id="solo"
                title="Solo"
                pageContent={sectionPage}
                action={
                  <IconButton
                    size="sm"
                    variant="ghost"
                    aria-label="New Solo chat"
                    icon={<PlusIcon size={16} strokeWidth={2} />}
                    onClick={() =>
                      void navigator.open(soloDraftTarget(session.scope))
                    }
                  />
                }
              >
                {soloChats.map((channel) => {
                  const entry = byId.get(`channel:${channel.id}`);
                  return entry ? sourceRow(entry, "solo") : null;
                })}
                {!soloChats.length && (
                  <p className={styles.note}>No Solo chats yet.</p>
                )}
              </RailGroup>
            ),
          },
          {
            id: "agents",
            title: "Agents",
            icon: <RobotIcon size={22} />,
            content: (
              <AgentAvatarArtworkProvider animated={!pageSection}>
                <RailGroup
                  avatarGrid
                  id="agents"
                  title="Agents"
                  footer={
                    <NavigationItem
                      label="View more"
                      data-rail-view-more=""
                      aria-label="View more agents"
                      icon={<ArrowRightIcon size={18} />}
                      onClick={() => onSelect("buzz.agents/agents")}
                    />
                  }
                >
                  {topAgents.map((entry) => sourceRow(entry, "agents"))}
                  {!topAgents.length && (
                    <p className={styles.note}>
                      {agents.pending ? "Loading agents…" : "No agents yet."}
                    </p>
                  )}
                </RailGroup>
              </AgentAvatarArtworkProvider>
            ),
          },
          ...contributed.map((section) => ({
            id: section.key,
            title: section.title,
            icon: <>{section.icon}</>,
            content: sidebarSections && (
              <ContributedRailSections
                registry={sidebarSections}
                navigator={navigator}
                partition={partition}
                only={section.key}
                fullPage={pageSection === section.key}
                renderSection={({ label, action, children }) => (
                  <RailGroup id={section.key} title={label} action={action}>
                    {children}
                  </RailGroup>
                )}
                renderRow={(id, label, target, content) => (
                  <RailSourceRow
                    key={id}
                    section={section.key}
                    entry={{
                      id: `contributed:${section.key}:${id}`,
                      label,
                      kind: "page",
                      target,
                    }}
                  >
                    {content}
                  </RailSourceRow>
                )}
              />
            ),
          })),
        ]}
      />
      {error && !picker && (
        <p role="alert" className={styles.note}>
          {error}
        </p>
      )}
      <Dialog
        open={picker}
        onOpenChange={setPicker}
        title="Add a pin"
        description="Keep a chat, person, channel, agent, or page close by."
        height="stable"
      >
        <div className={styles.picker}>
          {error && (
            <p role="alert" className={styles.note}>
              {error}
            </p>
          )}
          <Input
            aria-label="Find something to pin"
            placeholder="Search chats, people, channels…"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            autoFocus
          />
          <SidebarNavigation>
            {!query && (
              <NavigationSection label="Current view">
                <NavigationItem
                  label={`Pin ${current.label}`}
                  icon={<PinIcon size={18} />}
                  disabled={pinned.has(current.id)}
                  onClick={() => {
                    if (togglePin(current)) setPicker(false);
                  }}
                />
              </NavigationSection>
            )}
            <NavigationSection label="Destinations">
              {matches.map((entry) => (
                <NavigationItem
                  key={entry.id}
                  icon={artwork(entry)}
                  label={entry.label}
                  aria-label={`Pin ${entry.target.kind === "person" ? "person " : ""}${entry.label}`}
                  disabled={pinned.has(entry.id)}
                  trailing={
                    pinned.has(entry.id)
                      ? "Pinned"
                      : entry.target.kind === "person"
                        ? "Person"
                        : entry.kind === "person"
                          ? "Message"
                          : entry.kind
                  }
                  onClick={() => {
                    if (togglePin(entry)) setPicker(false);
                  }}
                />
              ))}
              {!matches.length && (
                <p className={styles.note}>No matches in this community.</p>
              )}
            </NavigationSection>
          </SidebarNavigation>
        </div>
      </Dialog>
    </>
  );
}

/** Observe each displayed conversation through the existing row read-state owner. */
function RailConversationItem({
  session,
  channel,
  avatarOnly = false,
  ...props
}: {
  session: RelaySession;
  channel: ChannelSummary;
  avatarOnly?: boolean;
} & Omit<
  ComponentProps<typeof ConversationRow>,
  "layout" | "state" | "time" | "preview"
>) {
  const state = useUnreadState(
    session,
    channel.id,
    channel.channelType === "dm",
  );
  const unread =
    state.unread ||
    (state.activity.items ?? []).some((item) => item.unreadCount > 0);
  return (
    <ConversationRow
      {...props}
      layout={avatarOnly ? "avatar" : "navigation"}
      time={null}
      preview={null}
      state={unread ? "unread" : "read"}
      aria-description={unread ? "Unread messages" : undefined}
    />
  );
}

const noSubscription = () => () => {};
const pluginCatalog: RailEntry = {
  id: "settings:plugins",
  label: "Plugins",
  kind: "page",
  target: { version: 1, kind: "settings", section: "plugins" },
};
const emptySections: readonly import("../../features/channel-navigation/sidebar-sections-service").RegisteredSidebarSection[] =
  [];
const noSections = () => emptySections;
