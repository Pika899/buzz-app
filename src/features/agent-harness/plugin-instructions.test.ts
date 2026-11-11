import { expect, it, vi } from "vitest";
import { pluginInstructions } from "./plugin-instructions";

it("keeps a turn's plugin instructions within 16 KB and names the plugins left out", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const full = "x".repeat(4096);
  const text = pluginInstructions([
    { plugin: "acme.a", text: full },
    { plugin: "acme.b", text: full },
    { plugin: "acme.c", text: full },
    { plugin: "acme.d", text: `${"x".repeat(4000)}` },
    { plugin: "acme.e", text: full },
    { plugin: "acme.f", text: "y".repeat(96) },
    { plugin: "acme.g", text: "z" },
  ]);
  const sections = text?.match(/<plugin-instructions plugin="[^"]+">/g);
  // Exactly 16 KB fits; e no longer does, but the smaller f still does.
  expect(sections).toEqual([
    '<plugin-instructions plugin="acme.a">',
    '<plugin-instructions plugin="acme.b">',
    '<plugin-instructions plugin="acme.c">',
    '<plugin-instructions plugin="acme.d">',
    '<plugin-instructions plugin="acme.f">',
  ]);
  expect(text).toMatch(
    /\n\n\(Buzz left out instructions from acme\.e, acme\.g: this turn's plugin instructions would be over 16 KB\.\)$/,
  );
  expect(warn).toHaveBeenCalledWith(
    "Plugin instructions over the turn limit were left out",
    ["acme.e", "acme.g"],
  );
  warn.mockRestore();
});

it("adds no note while a turn's instructions fit", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  expect(pluginInstructions([{ plugin: "acme.a", text: " Hi " }])).toBe(
    '<plugin-instructions plugin="acme.a">\nHi\n</plugin-instructions>',
  );
  expect(pluginInstructions([])).toBeUndefined();
  expect(warn).not.toHaveBeenCalled();
  warn.mockRestore();
});
