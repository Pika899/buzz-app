import { afterEach, expect, it, vi } from "vitest";
import {
  pluginInstructions,
  TURN_INSTRUCTIONS_LIMIT,
  utf8Bytes,
} from "./plugin-instructions";

const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
afterEach(() => warn.mockClear());

const plugins = (text?: string) =>
  text
    ?.match(/<plugin-instructions plugin="([^"]+)">/g)
    ?.map((tag) => tag.slice(29, -2));
const note = (text?: string) => text?.match(/\(Buzz left out .*\)$/)?.[0];

it("sends every section, tags included, while the whole block fits in 16 KB", () => {
  // What a section's tags take, and two bytes for each separator.
  const tags =
    utf8Bytes(pluginInstructions([{ plugin: "acme.a", text: "x" }]) ?? "") - 1;
  const body = (n: number) => "é".repeat(n / 2);
  const text = pluginInstructions([
    { plugin: "acme.a", text: body(4096) },
    { plugin: "acme.b", text: body(4096) },
    { plugin: "acme.c", text: body(4096) },
    { plugin: "acme.d", text: body(4096 - 4 * tags - 3 * 2) },
  ]);
  expect(utf8Bytes(text ?? "")).toBe(TURN_INSTRUCTIONS_LIMIT);
  expect(plugins(text)).toEqual(["acme.a", "acme.b", "acme.c", "acme.d"]);
  expect(note(text)).toBeUndefined();
  expect(warn).not.toHaveBeenCalled();
});

it("keeps the sections that fit, in order, and names the plugins left out", () => {
  const full = "x".repeat(4096);
  const text = pluginInstructions([
    { plugin: "acme.a", text: full },
    { plugin: "acme.b", text: full },
    { plugin: "acme.c", text: full },
    { plugin: "acme.d", text: full },
    { plugin: "acme.e", text: "y".repeat(96) },
  ]);
  expect(utf8Bytes(text ?? "")).toBeLessThanOrEqual(TURN_INSTRUCTIONS_LIMIT);
  // Four full sections no longer fit with their tags; the small one still does.
  expect(plugins(text)).toEqual(["acme.a", "acme.b", "acme.c", "acme.e"]);
  expect(note(text)).toBe(
    "(Buzz left out some instructions from acme.d: this turn's plugin instructions would be over 16 KB.)",
  );
  expect(warn).toHaveBeenCalledWith(
    "Plugin instructions over the turn limit were left out",
    ["acme.d"],
  );
  // The same plugins left out again log nothing new, even after a turn that
  // fit or one that left out others, as agents' turns interleave.
  warn.mockClear();
  pluginInstructions([{ plugin: "acme.a", text: full }]);
  pluginInstructions([
    { plugin: "acme.x", text: "x".repeat(TURN_INSTRUCTIONS_LIMIT) },
  ]);
  pluginInstructions([
    { plugin: "acme.a", text: full },
    { plugin: "acme.b", text: full },
    { plugin: "acme.c", text: full },
    { plugin: "acme.d", text: full },
  ]);
  expect(warn.mock.calls).toEqual([
    ["Plugin instructions over the turn limit were left out", ["acme.x"]],
  ]);
});

it("counts the tags of many short sections and the escapes in their text", () => {
  const many = pluginInstructions(
    Array.from({ length: 1000 }, (_, i) => ({
      plugin: "acme.many",
      text: `${i}`,
    })),
  );
  expect(utf8Bytes(many ?? "")).toBeLessThanOrEqual(TURN_INSTRUCTIONS_LIMIT);
  expect(note(many)).toContain("from acme.many:");
  // Each closing tag in the text gains a byte when escaped.
  const escaped = pluginInstructions(
    ["a", "b", "c", "d"].map((id) => ({
      plugin: `acme.${id}`,
      text: "</buzz-event>".repeat(315),
    })),
  );
  expect(utf8Bytes(escaped ?? "")).toBeLessThanOrEqual(TURN_INSTRUCTIONS_LIMIT);
  expect(plugins(escaped)).toEqual(["acme.a", "acme.b", "acme.c"]);
});

it("bounds the note, counting the plugins it cannot name", () => {
  const text = pluginInstructions([
    { plugin: "acme.big", text: "x".repeat(TURN_INSTRUCTIONS_LIMIT) },
    ...Array.from({ length: 200 }, (_, i) => ({
      plugin: `acme.plugin-${i}`,
      text: "x".repeat(4096),
    })),
  ]);
  expect(utf8Bytes(text ?? "")).toBeLessThanOrEqual(TURN_INSTRUCTIONS_LIMIT);
  expect(plugins(text)).toHaveLength(3);
  expect(note(text)).toMatch(
    /^\(Buzz left out some instructions from acme\.big, acme\.plugin-3, .* and \d+ more: /,
  );
  expect(utf8Bytes(note(text) ?? "")).toBeLessThan(512);
  // A name too long for the note is only counted.
  expect(
    note(
      pluginInstructions([
        { plugin: "a".repeat(600), text: "x".repeat(TURN_INSTRUCTIONS_LIMIT) },
      ]),
    ),
  ).toBe(
    "(Buzz left out some instructions from 1 plugin: this turn's plugin instructions would be over 16 KB.)",
  );
});

it("gives one trimmed section for small instructions, and nothing for none", () => {
  expect(pluginInstructions([{ plugin: "acme.a", text: " Hi " }])).toBe(
    '<plugin-instructions plugin="acme.a">\nHi\n</plugin-instructions>',
  );
  expect(pluginInstructions([])).toBeUndefined();
  expect(warn).not.toHaveBeenCalled();
});
