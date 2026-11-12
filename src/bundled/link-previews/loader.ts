import type { Host, HostPagePreview } from "../../features/host/service";
import { previewable } from "./safety";

export type Page = Readonly<{
  url: string;
  title: string;
  description?: string;
  siteName?: string;
  image?: string;
  imageAlt?: string;
}>;

const MAX_REDIRECTS = 5;
const PARALLEL = 4;
const KEEP_PAGES = 200;
const KEEP_IMAGES = 60;
const MAX_IMAGE_BYTES = 4_000_000;
const IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
]);

/** A decoded image and its size, so a card can lay out before it paints. */
export type Picture = Readonly<{ src: string; width: number; height: number }>;
/** What a card draws: its page and, when the page names one, its picture. */
export type Preview = Readonly<{ page: Page; picture?: Picture | null }>;

type Reader = Pick<Host, "readPage" | "requestBytes">;
type Held = { picture: Promise<Picture | null>; users: number; kept: boolean };
export type ImageLease = Readonly<{
  picture: Promise<Picture | null>;
  release(): void;
}>;

/** Reads previews and their images through the host, at most `PARALLEL` at
 * once, checking every redirect hop with `previewable` before asking again.
 * Results are kept for the session; failures are not. Image `src` values are
 * only ever `blob:` URLs, so the web view never fetches a page-chosen address. */
export function createLoader(host: Reader | undefined) {
  const readPage = host?.readPage?.bind(host);
  const requestBytes = host?.requestBytes?.bind(host);
  const pages = new Map<string, Promise<Page | null>>();
  const images = new Map<string, Held>();
  const settled = new WeakMap<Promise<unknown>, unknown>();
  /** Images whose last load failed, so a card that comes back draws its text
   * at once while the image is retried. */
  const failed = new Set<string>();
  const known = <T>(pending: Promise<T> | undefined) =>
    pending && settled.has(pending) ? (settled.get(pending) as T) : undefined;
  const waiting: (() => void)[] = [];
  let active = 0;
  let stopped = false;

  async function slot<T>(run: () => Promise<T>): Promise<T | null> {
    if (active >= PARALLEL)
      await new Promise<void>((resolve) => waiting.push(resolve));
    else active++;
    try {
      return stopped ? null : await run();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  }

  /** Follows redirects one checked hop at a time; `ask` returns the next
   * location to try, a final value, or null. */
  async function follow<T>(
    start: string,
    ask: (url: URL) => Promise<{ location: string } | { value: T } | null>,
  ): Promise<T | null> {
    let current = start;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const target = previewable(current);
      if (!target || stopped) return null;
      const reply = await slot(() => ask(target));
      if (!reply) return null;
      if ("value" in reply) return reply.value;
      try {
        current = new URL(reply.location, target).href;
      } catch {
        return null;
      }
    }
    return null;
  }

  const toPage = (url: string, preview: HostPagePreview): Page | null => {
    const title = preview.title?.trim();
    if (!title) return null;
    const image = preview.image && previewable(preview.image)?.href;
    return {
      url,
      title,
      ...(preview.description ? { description: preview.description } : {}),
      ...(preview.siteName ? { siteName: preview.siteName } : {}),
      ...(image ? { image } : {}),
      ...(preview.imageAlt ? { imageAlt: preview.imageAlt } : {}),
    };
  };

  function remember<T>(
    cache: Map<string, Promise<T | null>>,
    key: string,
    keep: number,
    load: () => Promise<T | null>,
  ) {
    const found = cache.get(key);
    if (found) {
      cache.delete(key);
      cache.set(key, found);
      return found;
    }
    const pending = load().catch(() => null);
    cache.set(key, pending);
    void pending.then((value) => {
      settled.set(pending, value);
      if (value === null && cache.get(key) === pending) cache.delete(key);
    });
    for (const old of cache.keys()) {
      if (cache.size <= keep) break;
      cache.delete(old);
    }
    return pending;
  }

  /** Marks an image most recently used, so eviction takes it last. */
  const touch = (url: string) => {
    const held = images.get(url);
    if (held) {
      images.delete(url);
      images.set(url, held);
    }
    return held;
  };
  const revoke = (held: Held) =>
    void held.picture.then(
      (picture) => picture && URL.revokeObjectURL(picture.src),
    );
  const revokeIfUnused = (held: Held) => {
    if (!held.kept && held.users === 0) revoke(held);
  };

  /** Fetches within a slot, then decodes outside it, so a slow decode never
   * holds up another preview's request. */
  const loadImage = async (url: string): Promise<Picture | null> => {
    const blob = await follow(url, async (target) => {
      if (!requestBytes) return null;
      const reply = await requestBytes({
        url: target.href,
        maxBytes: MAX_IMAGE_BYTES,
        timeoutMs: 8000,
      });
      const header = (name: string) =>
        Object.entries(reply.headers).find(
          ([key]) => key.toLowerCase() === name,
        )?.[1];
      if (reply.status >= 300 && reply.status < 400) {
        const location = header("location");
        return location ? { location } : null;
      }
      const type = (header("content-type") ?? "")
        .split(";")[0]
        ?.trim()
        .toLowerCase();
      if (
        reply.status !== 200 ||
        !reply.body.byteLength ||
        !type ||
        !IMAGE_TYPES.has(type) ||
        stopped
      )
        return null;
      return { value: new Blob([reply.body as BlobPart], { type }) };
    }).catch(() => null);
    if (!blob || stopped) return null;
    const src = URL.createObjectURL(blob);
    const image = new Image();
    image.src = src;
    try {
      await image.decode();
    } catch {
      URL.revokeObjectURL(src);
      return null;
    }
    const { naturalWidth: width, naturalHeight: height } = image;
    return { src, width, height };
  };

  return {
    available: !!readPage,
    page(url: string): Promise<Page | null> {
      if (!readPage) return Promise.resolve(null);
      return remember(pages, url, KEEP_PAGES, () =>
        follow(url, async (target) => {
          const reply = await readPage(target.href, { timeoutMs: 10_000 });
          if (reply.status >= 300 && reply.status < 400)
            return reply.location ? { location: reply.location } : null;
          return reply.preview
            ? { value: toPage(target.href, reply.preview) }
            : null;
        }),
      );
    },
    /** The preview a card has already drawn, if it is settled, so a card
     * that scrolls back into view draws at its final size on its first frame.
     * Its image counts as just used, so it outlasts the cache's other
     * entries until the card's lease takes hold. */
    ready(url: string): Preview | undefined {
      const page = known(pages.get(url));
      if (!page) return undefined;
      if (!page.image) return { page };
      const picture = failed.has(page.image)
        ? null
        : known(touch(page.image)?.picture);
      return picture === undefined ? undefined : { page, picture };
    },
    /** A lease on the image's decoded `blob:` URL. The cache keeps at most
     * `KEEP_IMAGES` for reuse, but a URL is revoked only once it has left the
     * cache and every lease on it is released. */
    image(url: string): ImageLease {
      if (!requestBytes || stopped)
        return { picture: Promise.resolve(null), release() {} };
      let held = touch(url);
      if (!held) {
        const entry: Held = { picture: loadImage(url), users: 0, kept: true };
        held = entry;
        images.set(url, entry);
        void entry.picture.then((picture) => {
          settled.set(entry.picture, picture);
          if (picture) failed.delete(url);
          else {
            if (images.get(url) === entry) {
              images.delete(url);
              entry.kept = false;
            }
            // Also when it was evicted while loading, unless a newer load
            // has taken its place.
            if (!images.has(url)) failed.add(url);
            for (const old of failed) {
              if (failed.size <= KEEP_IMAGES) break;
              failed.delete(old);
            }
          }
        });
        for (const [old, value] of images) {
          if (images.size <= KEEP_IMAGES) break;
          images.delete(old);
          value.kept = false;
          revokeIfUnused(value);
        }
      }
      const leased = held;
      leased.users++;
      let released = false;
      return {
        picture: leased.picture,
        release() {
          if (released) return;
          released = true;
          leased.users--;
          revokeIfUnused(leased);
        },
      };
    },
    stop() {
      stopped = true;
      for (const held of images.values()) {
        held.kept = false;
        revoke(held);
      }
      images.clear();
      failed.clear();
      pages.clear();
      const released = waiting.splice(0);
      active += released.length;
      for (const resolve of released) resolve();
    },
  };
}
export type Loader = ReturnType<typeof createLoader>;
