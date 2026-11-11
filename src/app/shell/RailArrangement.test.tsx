// @vitest-environment jsdom
import { memo } from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import { RailArrangement, RailGroup, RailSourceRow } from "./RailArrangement";
import { writeView } from "../../shared/view-state";
import type { RailEntry } from "./rail-pins";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

// Live component refreshes can retain an element's previous component identity.
// A real React wrapper exercises that boundary without mocking React's lifecycle.
test("row previews use entry metadata even when component identity is wrapped", () => {
  const SourceRow = memo(RailSourceRow);
  const entries: RailEntry[] = Array.from({ length: 6 }, (_, index) => ({
    id: `chat-${index}`,
    label: `Chat ${index + 1}`,
    kind: "chat",
    target: {
      version: 1,
      kind: "conversation",
      channelId: `chat-${index}`,
      scope: { viewer: "a".repeat(64), communityOrigin: "https://example.org" },
    },
  }));
  render(
    <RailArrangement
      partition="preview-test"
      isPinned={() => false}
      onTogglePin={() => {}}
      openSection={() => {}}
      renderEntry={(entry) => <NavigationItem label={entry.label} />}
      sections={[
        {
          id: "solo",
          title: "Solo",
          content: (
            <RailGroup id="solo" title="Solo">
              {entries.map((entry) => (
                <SourceRow key={entry.id} section="solo" entry={entry}>
                  <NavigationItem label={entry.label} />
                </SourceRow>
              ))}
            </RailGroup>
          ),
        },
      ]}
    />,
  );
  expect(screen.getByRole("button", { name: "Chat 4" })).not.toBeNull();
  expect(screen.queryByRole("button", { name: "Chat 5" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Chat 6" })).toBeNull();
  expect(screen.getByRole("button", { name: "View more Solo" })).not.toBeNull();
});

test.each(["pins", "custom:work", "agents"])(
  "the Agents card retains an agent placed in %s without duplicating it",
  (destination) => {
    const entry: RailEntry = {
      id: "agent:owned",
      label: "Owned agent",
      kind: "agent",
      target: { kind: "person", pubkey: "a".repeat(64) },
    };
    writeView("agent-placement", "navigation-layout:v1", {
      order: [],
      sections: [{ id: "custom:work", title: "Work" }],
      placements: [{ section: destination, entry }],
    });
    const view = render(
      <RailArrangement
        partition="agent-placement"
        isPinned={() => false}
        onTogglePin={() => {}}
        openSection={() => {}}
        renderEntry={(item) => <NavigationItem label={item.label} />}
        sections={[
          {
            id: "pins",
            title: "Pins",
            content: <RailGroup id="pins" title="Pins" />,
          },
          {
            id: "agents",
            title: "Agents",
            content: (
              <RailGroup id="agents" title="Agents">
                <RailSourceRow entry={entry} section="agents">
                  <NavigationItem label={entry.label} />
                </RailSourceRow>
              </RailGroup>
            ),
          },
        ]}
      />,
    );
    const agents = view.container.querySelector('[data-rail-section="agents"]');
    if (!(agents instanceof HTMLElement))
      throw new Error("Missing Agents card");
    expect(
      within(agents).getAllByRole("button", { name: "Owned agent" }),
    ).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Owned agent" })).toHaveLength(
      destination === "agents" ? 1 : 2,
    );
  },
);
