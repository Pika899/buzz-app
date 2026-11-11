import { motion, useReducedMotion } from "motion/react";
import {
  DndContext,
  DragOverlay,
  MouseSensor,
  TouchSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useDndContext,
  useSensor,
  useSensors,
  type CollisionDetection,
} from "@dnd-kit/core";
import {
  createContext,
  Children,
  isValidElement,
  useContext,
  useRef,
  useState,
  type ReactNode,
  type ReactElement,
  type ComponentProps,
} from "react";
import { createPortal } from "react-dom";
import { NavigationSection } from "../../shared/design-system/ui/NavigationSection";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import { Button } from "../../shared/design-system/ui/Button";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { Tooltip } from "../../shared/design-system/ui/Tooltip";
import {
  ContextMenuRoot,
  ContextMenuTrigger,
  MenuPopup,
  MenuItem,
  MenuGroup,
  MenuGroupLabel,
} from "../../shared/design-system/ui/Menu";
import {
  PlusIcon,
  ChatCircleIcon,
  ArrowRightIcon,
  GripHorizontalIcon,
  SquaresFourIcon,
} from "../../shared/design-system/icons";
import { CreateSidebarSection } from "../../bundled/channels/CreateSidebarSection";
import type { RailEntry } from "./rail-pins";
import { useRailLayout } from "./rail-layout";
import styles from "./RailArrangement.module.css";
import { Header } from "../../shared/design-system/ui/Header";
import { EmptyState } from "../../shared/design-system/ui/EmptyState";
import feedStyles from "../../features/conversation/FeedList.module.css";

type Group = {
  id: string;
  title: string;
  icon?: ReactElement;
  content: ReactNode;
};
type Arrangement = {
  pageSection?: string | undefined;
  selectedSection?: string | undefined;
  openSection(id: string): void;
  groups: { id: string; title: string }[];
  placements: ReturnType<typeof useRailLayout>["layout"]["placements"];
  assignedEntryIds: ReadonlySet<string>;
  move(entry: RailEntry, section: string): void;
  reorder(id: string, over: string): void;
  create(entry: RailEntry): void;
  remove(id: string): void;
  renderEntry(entry: RailEntry, section?: string): ReactNode;
  renderSectionList?:
    | ((
        id: string,
        title: string,
        entries: readonly RailEntry[],
        action: ReactNode,
      ) => ReactNode)
    | undefined;
  renderRowActions?:
    | ((entry: RailEntry, close: () => void, focus: () => void) => ReactNode)
    | undefined;
  isPinned(entry: RailEntry): boolean;
  onTogglePin(entry: RailEntry, pinned: boolean): void;
};
const ArrangementContext = createContext<Arrangement | null>(null);
const touchOptions = { activationConstraint: { delay: 250, tolerance: 5 } };
const pointerOptions = { activationConstraint: { distance: 6 } };
const collisions: CollisionDetection = (args) =>
  pointerWithin({
    ...args,
    droppableContainers: args.droppableContainers.filter((item) =>
      args.active.data.current?.section
        ? item.id !== "rail:new-section"
        : item.id !== "rail:top",
    ),
  });

export function RailArrangement({
  partition,
  sections,
  renderEntry,
  renderSectionList,
  renderRowActions,
  isPinned,
  onTogglePin,
  pageSection,
  selectedSection,
  openSection,
  compact = false,
}: {
  partition: string;
  sections: Group[];
  renderEntry(entry: RailEntry, section?: string): ReactNode;
  renderSectionList?:
    | ((
        id: string,
        title: string,
        entries: readonly RailEntry[],
        action: ReactNode,
      ) => ReactNode)
    | undefined;
  renderRowActions?:
    | ((entry: RailEntry, close: () => void, focus: () => void) => ReactNode)
    | undefined;
  isPinned(entry: RailEntry): boolean;
  onTogglePin(entry: RailEntry, pinned: boolean): void;
  pageSection?: string | undefined;
  selectedSection?: string | undefined;
  openSection(id: string): void;
  compact?: boolean;
}) {
  const { layout, move, reorder, create, remove } = useRailLayout(partition);
  const reducedMotion = useReducedMotion();
  const animateDrop = useRef(false);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState<RailEntry | null>();
  const newSectionButton = useRef<HTMLButtonElement>(null);
  const [dragging, setDragging] = useState<{ label: string }>();
  const sensors = useSensors(
    useSensor(MouseSensor, pointerOptions),
    useSensor(TouchSensor, touchOptions),
  );
  const groups: Group[] = [
    ...sections,
    ...layout.sections.map((section) => ({
      ...section,
      content: <RailGroup id={section.id} title={section.title} />,
    })),
  ];
  const order = [...layout.order, ...groups.map((group) => group.id)];
  groups.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  const saved = (ok: boolean) => {
    setError(ok ? "" : "Couldn’t save the sidebar on this device. Try again.");
    return ok;
  };
  const value: Arrangement = {
    pageSection,
    renderSectionList,
    selectedSection,
    openSection,
    groups: groups.map((group) => ({
      id: group.id,
      title: group.title,
    })),
    placements: layout.placements,
    assignedEntryIds: new Set(
      layout.placements
        .filter((item) => groups.some((group) => group.id === item.section))
        .map((item) => item.entry.id),
    ),
    move: (entry, section) => {
      saved(move(entry, section));
    },
    reorder: (id, over) => {
      saved(
        reorder(
          id,
          over,
          groups.map((group) => group.id),
        ),
      );
    },
    create: setCreating,
    remove: (id) => {
      saved(remove(id));
    },
    renderEntry,
    renderRowActions,
    isPinned,
    onTogglePin,
  };
  return (
    <ArrangementContext value={value}>
      <DndContext
        sensors={sensors}
        collisionDetection={collisions}
        accessibility={{ container: document.body }}
        onDragStart={({ active }) =>
          setDragging({
            label: active.data.current?.label ?? "",
          })
        }
        onDragCancel={() => {
          animateDrop.current = false;
          setDragging(undefined);
        }}
        onDragEnd={({ active, over }) => {
          setDragging(undefined);
          const data = active.data.current;
          animateDrop.current =
            !!over &&
            !reducedMotion &&
            (data?.section
              ? data.section !== over.id
              : !!data?.entry &&
                over.id !== data.source &&
                over.id !== "rail:new-section");
          if (!over) return;
          if (data?.section)
            value.reorder(
              data.section,
              over.id === "rail:top"
                ? (groups[0]?.id ?? data.section)
                : String(over.id),
            );
          else if (data?.entry) {
            if (over.id === "rail:new-section") setCreating(data.entry);
            else if (over.id !== data.source)
              value.move(data.entry, String(over.id));
          }
        }}
      >
        {pageSection ? (
          (groups.find((group) => group.id === pageSection)?.content ?? (
            <EmptyState
              icon={<ChatCircleIcon />}
              title="Section unavailable"
              description="This sidebar section may have been removed."
            />
          ))
        ) : (
          <>
            {compact && (
              <section className={styles.dock} aria-label="Sidebar sections">
                {groups.map((group) => (
                  <div key={group.id} className={styles.dockTile}>
                    <Tooltip content={group.title} hint="dock" side="right">
                      <IconButton
                        size="md"
                        aria-label={group.title}
                        aria-current={
                          selectedSection === group.id ? "page" : undefined
                        }
                        data-selected={
                          selectedSection === group.id || undefined
                        }
                        icon={group.icon ?? <SquaresFourIcon size={22} />}
                        onClick={() => openSection(group.id)}
                      />
                    </Tooltip>
                  </div>
                ))}
              </section>
            )}
            <div hidden={compact}>
              <div
                className={styles.groups}
                onKeyDownCapture={(event) => {
                  // Escape belongs to the active move before the shell's rail dismissal.
                  if (dragging && event.key === "Escape")
                    event.preventDefault();
                }}
              >
                <FirstSectionTarget />
                {groups.map((group) => (
                  <motion.div
                    key={group.id}
                    layout="position"
                    layoutDependency={layout}
                    initial={false}
                    transition={{
                      layout: animateDrop.current
                        ? { type: "spring", duration: 0.28, bounce: 0.15 }
                        : { duration: 0 },
                    }}
                    onLayoutAnimationComplete={() => {
                      animateDrop.current = false;
                    }}
                  >
                    {group.content}
                  </motion.div>
                ))}
              </div>
              <div className={styles.createSection}>
                <Button
                  ref={newSectionButton}
                  size="sm"
                  variant="subtle"
                  onClick={() => setCreating(null)}
                >
                  New section
                </Button>
              </div>
              <NewSectionTarget />
            </div>
          </>
        )}
        {createPortal(
          <DragOverlay dropAnimation={null}>
            {dragging && (
              <div className={styles.overlay}>
                <NavigationItem label={dragging.label} />
              </div>
            )}
          </DragOverlay>,
          document.body,
        )}
      </DndContext>
      {error && (
        <p role="alert" className="text-caption text-secondary">
          {error}
        </p>
      )}
      {creating !== undefined && (
        <CreateSidebarSection
          channelName={creating?.label}
          finalFocus={creating === null ? newSectionButton : false}
          writable
          refreshing={false}
          retry={async () => {}}
          close={() => setCreating(undefined)}
          create={({ id, name }) => {
            if (
              !saved(
                create(
                  id,
                  name,
                  creating ?? undefined,
                  groups.map((group) => group.id),
                ),
              )
            )
              throw new Error("Couldn’t save this section. Try again.");
            setCreating(undefined);
            return true;
          }}
        />
      )}
    </ArrangementContext>
  );
}

/** Shared section/row paint stays with NavigationSection and NavigationItem. */
export function RailGroup({
  id,
  title,
  action,
  children,
  footer,
  rowsLabel,
  unlimited = false,
  avatarGrid = id === "pins",
  trailingEntryId,
  sortEntries,
  pageContent,
}: {
  id: string;
  title: string;
  action?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  rowsLabel?: string;
  unlimited?: boolean;
  avatarGrid?: boolean;
  trailingEntryId?: string;
  sortEntries?: (a: RailEntry, b: RailEntry) => number;
  pageContent?: ReactNode;
}) {
  const arrangement = useContext(ArrangementContext);
  const { active } = useDndContext();
  const drop = useDroppable({
    id,
    resizeObserverConfig: { updateMeasurementsFor: [] },
  });
  const drag = useDraggable({
    id: `section:${id}`,
    data: { section: id, label: title },
  });
  const grabber = useRef<HTMLSpanElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement>();
  const movableGroups = arrangement?.groups ?? [];
  const index = movableGroups.findIndex((group) => group.id === id);
  const sectionDrag = !!active?.data.current?.section;
  const target = drop.isOver && active?.data.current?.section !== id;
  const sourceIndex = movableGroups.findIndex(
    (group) => group.id === active?.data.current?.section,
  );
  const insertionEdge =
    target && sectionDrag && sourceIndex >= 0 && index >= 0
      ? sourceIndex < index
        ? "after"
        : "before"
      : undefined;
  const rows: ReactElement<{ entry: RailEntry }>[] = [];
  const notes: ReactNode[] = [];
  for (const child of Children.toArray(children)) {
    if (
      isValidElement<ComponentProps<typeof RailSourceRow>>(child) &&
      child.props.entry &&
      child.props.section === id
    ) {
      if (
        id === "agents" ||
        !arrangement?.assignedEntryIds.has(child.props.entry.id)
      )
        rows.push(child);
    } else notes.push(child);
  }
  const placed =
    arrangement?.placements.filter((item) => item.section === id) ?? [];
  for (const { entry } of placed) {
    if (rows.some((row) => row.props.entry.id === entry.id)) continue;
    rows.push(
      <RailDestinationRow key={entry.id} entry={entry} section={id}>
        {arrangement?.renderEntry(entry, id)}
      </RailDestinationRow>,
    );
  }
  if (sortEntries)
    rows.sort((a, b) => sortEntries(a.props.entry, b.props.entry));
  if (trailingEntryId)
    rows.sort(
      (a, b) =>
        Number(a.props.entry.id === trailingEntryId) -
        Number(b.props.entry.id === trailingEntryId),
    );
  const limited = id !== "pins" && !unlimited;
  const shown = limited ? rows.slice(0, 4) : rows;
  const more = limited && rows.length > 4 && (!footer || placed.length > 0);
  if (arrangement?.pageSection === id && pageContent) return pageContent;
  if (
    arrangement?.pageSection === id &&
    arrangement.renderSectionList &&
    (id === "pins" || id.startsWith("custom:"))
  )
    return arrangement.renderSectionList(
      id,
      title,
      rows.map((row) => row.props.entry),
      action,
    );
  if (arrangement?.pageSection === id)
    return (
      <section className={feedStyles.page} aria-label={title}>
        <Header title={title} actions={action} />
        <div className={`${feedStyles.scroll} ${styles.pageRows}`}>
          {rows.map((row) => (
            <div key={row.key} className={styles.pageRow}>
              {row}
            </div>
          ))}
          {notes}
        </div>
      </section>
    );
  const card = (
    <div
      ref={(node) => {
        drop.setNodeRef(node);
        drag.setNodeRef(node);
      }}
      className={styles.group}
      onPointerMove={(event) => {
        if (event.pointerType !== "mouse" || !grabber.current) return;
        const bounds = grabber.current.getBoundingClientRect();
        const distance = Math.hypot(
          Math.max(
            bounds.left - event.clientX,
            0,
            event.clientX - bounds.right,
          ),
          Math.max(
            bounds.top - event.clientY,
            0,
            event.clientY - bounds.bottom,
          ),
        );
        // Brighten within one handle width without rerendering the rail on movement.
        const opacity = Math.max(0, 1 - distance / bounds.width);
        event.currentTarget.style.setProperty(
          "--rail-grabber-proximity",
          String(opacity),
        );
      }}
      onPointerLeave={(event) => {
        event.currentTarget.style.removeProperty("--rail-grabber-proximity");
      }}
      data-rail-section={id}
      data-drop-target={target || undefined}
      data-section-drag={sectionDrag || undefined}
      data-insertion-edge={insertionEdge}
      data-dragging={drag.isDragging || undefined}
    >
      <span ref={grabber} className={styles.grabber}>
        <IconButton
          ref={drag.setActivatorNodeRef}
          {...drag.listeners}
          aria-label={`Move ${title} section`}
          icon={
            <GripHorizontalIcon
              size={24}
              strokeWidth={2}
              fill="currentColor"
              className={`${styles.grabDots} text-subtle`}
            />
          }
          aria-keyshortcuts="ArrowUp ArrowDown"
          aria-description="Use the Up and Down arrow keys to move this section."
          onKeyDown={(event) => {
            const offset =
              event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0;
            if (!offset) return;
            event.preventDefault();
            const neighbor = movableGroups[index + offset];
            if (neighbor) arrangement?.reorder(id, neighbor.id);
          }}
        />
      </span>
      <NavigationSection
        label={
          <Button
            variant="plain"
            size="text"
            onClick={() => arrangement?.openSection(id)}
          >
            {title}
          </Button>
        }
        action={action && <span data-rail-card-actions="">{action}</span>}
      >
        {rowsLabel ? (
          <ul aria-label={rowsLabel} className={styles.rows}>
            {shown.map((row) => (
              <li key={row.key}>{row}</li>
            ))}
          </ul>
        ) : avatarGrid ? (
          <div
            className={styles.avatarGrid}
            data-pins-grid={id === "pins" ? "" : undefined}
          >
            {shown}
          </div>
        ) : (
          shown
        )}
        {notes}
        {more && (
          <NavigationItem
            label="View more"
            data-rail-view-more=""
            aria-label={`View more ${title}`}
            icon={<ArrowRightIcon size={18} />}
            selected={arrangement?.selectedSection === id}
            onClick={() => arrangement?.openSection(id)}
          />
        )}
        {!more && footer}
      </NavigationSection>
    </div>
  );
  return id.startsWith("custom:") ? (
    <ContextMenuRoot open={menuOpen} onOpenChange={setMenuOpen}>
      <ContextMenuTrigger
        onContextMenu={() => setMenuAnchor(undefined)}
        onKeyDown={(event) => {
          if (
            event.key === "ContextMenu" ||
            (event.shiftKey && event.key === "F10")
          ) {
            event.preventDefault();
            setMenuAnchor(event.currentTarget);
            setMenuOpen(true);
          }
        }}
      >
        {card}
      </ContextMenuTrigger>
      <MenuPopup anchor={menuAnchor}>
        <MenuItem onClick={() => arrangement?.remove(id)}>
          Remove section
        </MenuItem>
      </MenuPopup>
    </ContextMenuRoot>
  ) : (
    card
  );
}

/** Agents retain their inventory entry; other rows move to their chosen section. */
export function RailSourceRow({
  entry,
  section,
  children,
}: {
  entry: RailEntry;
  section: string;
  children: ReactNode;
}) {
  const arrangement = useContext(ArrangementContext);
  if (section !== "agents" && arrangement?.assignedEntryIds.has(entry.id))
    return null;
  return (
    <RailDestinationRow entry={entry} section={section}>
      {children}
    </RailDestinationRow>
  );
}
export function RailDestinationRow({
  entry,
  section,
  children,
}: {
  entry: RailEntry;
  section: string;
  children: ReactNode;
}) {
  const arrangement = useContext(ArrangementContext);
  const pinned = section === "pins" || arrangement?.isPinned(entry);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement>();
  const drag = useDraggable({
    id: `row:${section}:${entry.id}`,
    disabled: !!arrangement?.pageSection,
    data: { entry, source: section, label: entry.label },
  });
  return (
    <ContextMenuRoot open={menuOpen} onOpenChange={setMenuOpen}>
      <ContextMenuTrigger
        onContextMenu={() => setMenuAnchor(undefined)}
        onTouchStart={() => setMenuAnchor(undefined)}
        onKeyDown={(event) => {
          if (
            event.key === "ContextMenu" ||
            (event.shiftKey && event.key === "F10")
          ) {
            event.preventDefault();
            setMenuAnchor(event.currentTarget);
            setMenuOpen(true);
          }
        }}
        render={
          <div
            ref={drag.setNodeRef}
            {...drag.listeners}
            className={styles.row}
            data-rail-row={entry.id}
            data-dragging={drag.isDragging || undefined}
          />
        }
      >
        {children}
      </ContextMenuTrigger>
      <MenuPopup anchor={menuAnchor}>
        {arrangement?.renderRowActions?.(
          entry,
          () => setMenuOpen(false),
          () =>
            drag.node.current?.querySelector<HTMLElement>("button")?.focus(),
        )}
        <MenuItem onClick={() => arrangement?.onTogglePin(entry, !pinned)}>
          {pinned ? "Unpin" : "Pin"}
        </MenuItem>
        <MenuGroup>
          <MenuGroupLabel>Move to</MenuGroupLabel>
          {arrangement?.groups.map((group) => (
            <MenuItem
              key={group.id}
              disabled={group.id === section}
              onClick={() => arrangement.move(entry, group.id)}
            >
              {group.title}
            </MenuItem>
          ))}
        </MenuGroup>
        <MenuItem onClick={() => arrangement?.create(entry)}>
          New section…
        </MenuItem>
      </MenuPopup>
    </ContextMenuRoot>
  );
}
function FirstSectionTarget() {
  const { active } = useDndContext();
  const { setNodeRef, isOver } = useDroppable({
    id: "rail:top",
    disabled: !active?.data.current?.section,
  });
  return (
    <div
      ref={setNodeRef}
      className={styles.firstSectionTarget}
      data-drop-target={isOver || undefined}
      aria-hidden="true"
    />
  );
}

function NewSectionTarget() {
  const { active } = useDndContext();
  const shown = !!active && !active.data.current?.section;
  const { setNodeRef, isOver } = useDroppable({
    id: "rail:new-section",
    disabled: !shown,
  });
  const content = (
    <div
      ref={setNodeRef}
      className={styles.newSection}
      data-shown={shown || undefined}
      aria-hidden={!shown}
      inert={!shown}
    >
      <section
        className={styles.newSectionReveal}
        aria-label="New section"
        data-drop-target={isOver || undefined}
      >
        <div className={styles.newSectionLabel}>
          <PlusIcon size={16} aria-hidden="true" />
          <span>New section</span>
        </div>
      </section>
    </div>
  );
  const slot = document.getElementById("rail-drop-slot");
  return slot ? createPortal(content, slot) : content;
}
