// Document screens that share the Markdown renderer, each with the same
// sample, for rendered checks across themes, widths and text sizes.
import { createRoot } from "react-dom/client";
import { PluginReadme } from "../../src/app/PluginReadme";
import { CanvasMarkdown } from "../../src/bundled/channels/CanvasView";
import { GitHubBody } from "../../src/bundled/github/GitHubBody";
import { InstructionsMarkdown } from "../../src/bundled/watching/InstructionsMarkdown";
import { ToastProvider } from "../../src/shared/design-system/ui/Toast";
import "../../src/shared/styles/globals.css";

const SAMPLE = [
  "# Title",
  "## Section",
  "### Topic",
  "#### Detail",
  "Text with `code`, ~~gone~~ and [a link](https://example.com).",
  "- one\n  - two\n    - three",
  "1. first\n2. second",
  "- [x] done",
  "> quoted",
  "---",
  "| a | b |\n| - | - |\n| 1 | 2 |",
  "```\nconst value = 1;\n```",
].join("\n\n");

const params = new URLSearchParams(location.search);
document.documentElement.dataset.colorMode = params.get("mode") ?? "light";
document.documentElement.dataset.fontSize = params.get("size") ?? "default";

const root = document.getElementById("root");
if (!root) throw new Error("Missing fixture root");
createRoot(root).render(
  <ToastProvider>
    <main
      style={{
        width: Number(params.get("width") ?? 1100),
        padding: 16,
        background: "var(--surface-panel)",
        color: "var(--text-standard)",
      }}
    >
      <section data-screen="canvas">
        <CanvasMarkdown content={SAMPLE} openLink={() => false} />
      </section>
      <section data-screen="plugin-readme">
        <PluginReadme text={SAMPLE} />
      </section>
      <section data-screen="github">
        <GitHubBody body={SAMPLE} url="https://github.com/o/r/pull/1" />
      </section>
      <section data-screen="attention">
        <InstructionsMarkdown text={SAMPLE} />
      </section>
    </main>
  </ToastProvider>,
);
