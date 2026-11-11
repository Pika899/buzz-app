// @vitest-environment jsdom
// Each screen's raw-HTML, image and URL policy, recorded before the shared
// renderer existed. Only Attention changes: it gained GFM autolinks.
import { cleanup, render } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, expect, it } from "vitest";
import { PluginReadme } from "../../app/PluginReadme";
import { CanvasMarkdown } from "../../bundled/channels/CanvasView";
import { GitHubBody } from "../../bundled/github/GitHubBody";
import { InstructionsMarkdown } from "../../bundled/watching/InstructionsMarkdown";
import { ToastProvider } from "../../shared/design-system/ui/Toast";

afterEach(cleanup);

const INPUTS = {
  html: "<script>alert(1)</script> and <mark>x</mark>",
  javascript: "[a](javascript:alert(1))",
  data: "[a](data:text/html,x)",
  vbscript: "[a](vbscript:x)",
  credentialed: "[a](https://u:p@example.com/)",
  relative: "[a](docs/page) [b](#part)",
  mailto: "[a](mailto:me@example.com)",
  buzz: "[a](buzz://channel/general)",
  profile: `[a](nostr:npub1${"q".repeat(58)})`,
  image: "![alt](https://example.com/a.png)",
  autolink: "see https://example.com/x",
};
const SCREENS: Record<string, (content: string) => ReactElement> = {
  canvas: (content) => (
    <CanvasMarkdown content={content} openLink={() => false} />
  ),
  pluginReadme: (content) => <PluginReadme text={content} />,
  github: (content) => (
    <GitHubBody body={content} url="https://github.com/o/r/pull/1" />
  ),
  attention: (content) => <InstructionsMarkdown text={content} />,
};

function observe(element: ReactElement) {
  const { container } = render(element, { wrapper: ToastProvider });
  const record = {
    elements: ["script", "mark", "img"]
      .filter((tag) => container.querySelector(tag))
      .join(" "),
    text: container.textContent?.replace(/\s+/g, " ").trim(),
    links: [...container.querySelectorAll("a, button[class]")].map(
      (link) => link.getAttribute("href") ?? `<${link.tagName.toLowerCase()}>`,
    ),
  };
  cleanup();
  return record;
}

it("keeps each screen's trust policy", async () => {
  const records = Object.fromEntries(
    Object.entries(SCREENS).map(([screen, draw]) => [
      screen,
      Object.fromEntries(
        Object.entries(INPUTS).map(([name, input]) => [
          name,
          observe(draw(input)),
        ]),
      ),
    ]),
  );
  await expect(`${JSON.stringify(records, null, 2)}\n`).toMatchFileSnapshot(
    "./__trust__/screens.txt",
  );
});
