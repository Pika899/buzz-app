import type { ReactNode } from "react";
import { AvatarArtworkContext } from "../../shared/design-system/ui/Avatar";
import { PackedAgentAvatar } from "./PackedAgentAvatar";
import { agentAvatars } from "./avatar-packs";

const packsBySource = new Map(
  agentAvatars.flatMap((avatar) => [
    [avatar.url, avatar] as const,
    [avatar.preview, avatar] as const,
  ]),
);
function renderArtwork(src: string) {
  const avatar = packsBySource.get(src);
  return avatar ? (
    <img
      data-loaded="true"
      src={avatar.preview}
      alt=""
      style={{ width: "100%", height: "100%", objectFit: "contain" }}
    />
  ) : null;
}

function renderAnimatedArtwork(src: string) {
  const avatar = packsBySource.get(src);
  return avatar ? <PackedAgentAvatar avatar={avatar} /> : null;
}

/** Shared avatars stay static unless their host explicitly opts into animation. */
export function AgentAvatarArtworkProvider({
  children,
  animated = false,
}: {
  children: ReactNode;
  animated?: boolean;
}) {
  return (
    <AvatarArtworkContext
      value={animated ? renderAnimatedArtwork : renderArtwork}
    >
      {children}
    </AvatarArtworkContext>
  );
}
