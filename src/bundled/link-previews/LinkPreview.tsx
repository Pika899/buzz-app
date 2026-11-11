import { useEffect, useState } from "react";
import type { LinkPreviewProps } from "../../features/conversation/contracts";
import type { Loader, Preview } from "./loader";
import { domainOf } from "./safety";
import styles from "./LinkPreview.module.css";

/** The card's page and picture once both settle, so it draws once at its final
 * size; a card that scrolls back into view starts from the loader's copy. */
function usePreview(loader: Loader, url: string) {
  const [preview, setPreview] = useState(() => loader.ready(url));
  useEffect(() => {
    let live = true;
    let release = () => {};
    setPreview(loader.ready(url));
    void loader.page(url).then((page) => {
      if (!live || !page) return;
      if (!page.image) return setPreview({ page });
      const lease = loader.image(page.image);
      release = lease.release;
      void lease.picture.then(
        (picture) => live && setPreview({ page, picture }),
      );
    });
    return () => {
      live = false;
      release();
    };
  }, [loader, url]);
  return preview;
}

export function LinkPreview({
  url,
  open,
  loader,
}: LinkPreviewProps & { loader: Loader }) {
  const preview: Preview | undefined = usePreview(loader, url);
  if (!preview) return null;
  const { page, picture } = preview;
  const domain = domainOf(url);
  const site =
    page.siteName && page.siteName.toLowerCase() !== domain.toLowerCase()
      ? `${page.siteName} · ${domain}`
      : domain;
  return (
    <a
      className={styles.card}
      href={url}
      data-wide={(picture && picture.width > picture.height * 1.3) || undefined}
      onClick={(event) => {
        event.preventDefault();
        open();
      }}
    >
      {picture && (
        <span className={styles.media}>
          <img
            src={picture.src}
            alt={page.imageAlt ?? ""}
            width={picture.width}
            height={picture.height}
          />
        </span>
      )}
      <span className={styles.body}>
        <span className={styles.site}>{site}</span>
        <span className={styles.title}>{page.title}</span>
        {page.description && (
          <span className={styles.description}>{page.description}</span>
        )}
      </span>
    </a>
  );
}
