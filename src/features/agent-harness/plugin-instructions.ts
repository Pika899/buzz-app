// The standing instructions plugins give every turn (`Agents.addInstructions`),
// shown the same way whatever harness runs the agent.
import type { TurnInstructions } from "../agents/service";
import { unframed } from "./plugin-wake";

/** Most UTF-8 bytes one `addInstructions` text may have, after trimming.
 * They go with every turn, so this matches a watch classifier's true/false
 * text, not the once-a-session blocks such as agent instructions. */
export const INSTRUCTIONS_TEXT_LIMIT = 4 * 1024;
/** Most UTF-8 bytes of the whole block one turn carries from all plugins, as
 * sent: sections, their tags and the note about any left out. The same as an
 * Interest's instructions. */
export const TURN_INSTRUCTIONS_LIMIT = 16 * 1024;
/** Room kept for the note when some instructions are left out. */
const OMITTED_NOTE_LIMIT = 512;
const SEPARATOR = "\n\n";
let lastOmitted = "";

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
 * The result is at most `TURN_INSTRUCTIONS_LIMIT` bytes: when the sections do
 * not all fit, they are kept in order while they fit in what the note leaves,
 * and the note names the plugins left out. */
export function pluginInstructions(entries: readonly TurnInstructions[] = []) {
  const sections = entries.map(({ plugin, text }) => ({
    plugin: label(plugin),
    text: section(plugin, text),
  }));
  const all = sections.map(({ text }) => text).join(SEPARATOR);
  if (utf8Bytes(all) <= TURN_INSTRUCTIONS_LIMIT) {
    lastOmitted = "";
    return all || undefined;
  }
  let room = TURN_INSTRUCTIONS_LIMIT - OMITTED_NOTE_LIMIT;
  const kept: string[] = [];
  const omitted = new Set<string>();
  for (const { plugin, text } of sections) {
    const size = utf8Bytes(text) + (kept.length ? SEPARATOR.length : 0);
    if (size > room) omitted.add(plugin);
    else {
      kept.push(text);
      room -= size;
    }
  }
  // Once for each new set left out, not on every turn while it lasts.
  const key = [...omitted].join(" ");
  if (key !== lastOmitted)
    console.warn("Plugin instructions over the turn limit were left out", [
      ...omitted,
    ]);
  lastOmitted = key;
  return [...kept, omittedNote([...omitted])].join(SEPARATOR);
}

function section(plugin: string, text: string) {
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
}

/** The note naming the plugins left out, within `OMITTED_NOTE_LIMIT` with its
 * separator: names that do not fit are counted instead. */
function omittedNote(plugins: readonly string[]) {
  const end = `: this turn's plugin instructions would be over ${TURN_INSTRUCTIONS_LIMIT / 1024} KB.)`;
  // Room for "(Buzz left out some instructions from ", the end, the separator
  // and " and 1000000 more".
  let room = OMITTED_NOTE_LIMIT - 39 - utf8Bytes(end) - SEPARATOR.length - 17;
  const named: string[] = [];
  for (const plugin of plugins) {
    const size = plugin.length + (named.length ? 2 : 0);
    if (size > room) break;
    named.push(plugin);
    room -= size;
  }
  const rest = plugins.length - named.length;
  const who = !named.length
    ? `${rest} plugin${rest === 1 ? "" : "s"}`
    : rest
      ? `${named.join(", ")} and ${rest} more`
      : named.join(", ");
  return `(Buzz left out some instructions from ${who}${end}`;
}

const label = (plugin: string) => plugin.replace(/[^\w.:-]/g, "");
