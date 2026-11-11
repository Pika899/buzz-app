// The standing instructions plugins give every turn (`Agents.addInstructions`),
// shown the same way whatever harness runs the agent.
import type { TurnInstructions } from "../agents/service";
import { unframed } from "./plugin-wake";

/** Most UTF-8 bytes one `addInstructions` text may have. They go with every
 * turn, so this matches a watch classifier's true/false text, not the
 * once-a-session blocks such as agent instructions. */
export const INSTRUCTIONS_TEXT_LIMIT = 4 * 1024;
/** Most UTF-8 bytes of instruction text one turn carries from all plugins:
 * the same as an Interest's instructions. */
export const TURN_INSTRUCTIONS_LIMIT = 16 * 1024;

export const utf8Bytes = (text: string) =>
  new TextEncoder().encode(text).length;

/** One `<plugin-instructions>` section for each plugin's instructions, or
 * undefined when there are none. A turn's sections are the complete current
 * set, which the base prompt says replaces earlier turns'. Each section names
 * its plugin, so a transcript shows which plugin gave which instructions: a
 * plugin's text cannot open a section posing as another plugin's, or close
 * its own, the turn's event or its steer section early (steering finds the
 * event by its closing tag). That keeps the prompt well formed and attributed;
 * it is not a trust boundary, since the text is the trusted plugin's own.
 * Entries are kept in order while their text fits in
 * `TURN_INSTRUCTIONS_LIMIT`; a last line names the plugins left out. */
export function pluginInstructions(entries: readonly TurnInstructions[] = []) {
  let room = TURN_INSTRUCTIONS_LIMIT;
  const omitted = new Set<string>();
  const kept = entries.filter(({ plugin, text }) => {
    const size = utf8Bytes(text.trim());
    if (size > room) {
      omitted.add(label(plugin));
      return false;
    }
    room -= size;
    return true;
  });
  if (omitted.size)
    console.warn("Plugin instructions over the turn limit were left out", [
      ...omitted,
    ]);
  const sections = kept.map(({ plugin, text }) => {
    const body = unframed(
      text
        .trim()
        .replace(/<plugin-instructions/gi, "<\\plugin-instructions")
        .replace(
          /<\/(plugin-instructions|buzz-event|new-message-arrived-while-you-were-working)/gi,
          "<\\/$1",
        ),
    );
    return `<plugin-instructions plugin="${label(plugin)}">\n${body}\n</plugin-instructions>`;
  });
  if (omitted.size)
    sections.push(
      `(Buzz left out instructions from ${[...omitted].join(", ")}: this turn's plugin instructions would be over ${TURN_INSTRUCTIONS_LIMIT / 1024} KB.)`,
    );
  return sections.length ? sections.join("\n\n") : undefined;
}

const label = (plugin: string) => plugin.replace(/[^\w.:-]/g, "");
