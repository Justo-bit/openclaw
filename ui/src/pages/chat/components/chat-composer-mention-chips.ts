import { html } from "lit";
import type { ComposerChip } from "../../../components/composer-editor.ts";
import type { HumanMention } from "../../../lib/chat/chat-types.ts";
import { readHumanMentions } from "../../../lib/chat/human-mentions.ts";
import { renderChatAuthorAvatar } from "./chat-author-avatar.ts";
import avatarStyles from "../../../styles/chat/author-avatar.css?inline";

export function resolveComposerMentionChips(
  value: string,
  draftText: string,
  mentions: readonly HumanMention[] | undefined,
  avatarUrls: ReadonlyMap<string, string>,
): readonly ComposerChip[] {
  // The editor resolves a transaction before the draft owner updates its mention offsets.
  if (value !== draftText) {
    return [];
  }
  return (readHumanMentions(value, mentions) ?? []).map((mention) => {
    const name = value.slice(mention.start + 1, mention.end);
    return {
      kind: "mention",
      start: mention.start,
      end: mention.end,
      label: name,
      // The editor has a shadow root; reuse the avatar owner and its stylesheet there.
      icon: html`<style>
          ${avatarStyles}</style
        >${renderChatAuthorAvatar({
          id: mention.profileId,
          name,
          identity: { type: "profile", id: mention.profileId },
          profileAvatarUrl: avatarUrls.get(mention.profileId),
        })}`,
    };
  });
}
