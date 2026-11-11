// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { LinkPreview } from "./LinkPreview";
import type { Loader, Page } from "./loader";

afterEach(cleanup);

const loader = (page: Page | null): Loader =>
  ({
    available: true,
    page: vi.fn(async () => page),
    ready: vi.fn(() => undefined),
    image: vi.fn(() => ({ picture: Promise.resolve(null), release: vi.fn() })),
    stop: vi.fn(),
  }) as unknown as Loader;

it("shows the link's real domain beside the page's own site name", async () => {
  const open = vi.fn(() => true);
  render(
    <LinkPreview
      url="https://www.example.com/post"
      messageId="m"
      open={open}
      loader={loader({
        url: "https://www.example.com/post",
        title: "A post",
        description: "About things",
        siteName: "Example Blog",
      })}
    />,
  );
  const card = await screen.findByRole("link", { name: /A post/ });
  expect(card.getAttribute("href")).toBe("https://www.example.com/post");
  expect(screen.getByText("Example Blog · example.com")).toBeTruthy();
  expect(screen.getByText("About things")).toBeTruthy();
  fireEvent.click(card);
  expect(open).toHaveBeenCalledOnce();
});

it("renders nothing when the page has no preview", async () => {
  const empty = loader(null);
  const { container } = render(
    <LinkPreview
      url="https://example.com/"
      messageId="m"
      open={() => true}
      loader={empty}
    />,
  );
  await vi.waitFor(() => expect(empty.page).toHaveBeenCalled());
  expect(container.innerHTML).toBe("");
});

it("draws a card it has already shown at its final size on the first frame", () => {
  const page = {
    url: "https://github.com/block/buzz-app/pull/1",
    title: "A pull request",
    image: "https://opengraph.githubassets.com/a.png",
  };
  const seen = {
    ...loader(page),
    ready: vi.fn(() => ({
      page,
      picture: { src: "blob:test/a", width: 1200, height: 600 },
    })),
  } as unknown as Loader;
  render(
    <LinkPreview
      url={page.url}
      messageId="m"
      open={() => true}
      loader={seen}
    />,
  );
  const card = screen.getByRole("link", { name: /A pull request/ });
  expect(card.hasAttribute("data-wide")).toBe(true);
  const image = card.querySelector("img");
  expect(image?.getAttribute("src")).toBe("blob:test/a");
  expect(image?.getAttribute("width")).toBe("1200");
  expect(image?.getAttribute("height")).toBe("600");
});
