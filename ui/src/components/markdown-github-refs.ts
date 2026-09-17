import type { MarkdownIt, Token } from "markdown-it";
import { hasMarkdownLinkBoundaries } from "./markdown-link-boundary.ts";
import type { MarkdownRenderEnv } from "./markdown-render-options.ts";

// Keep item numbers aligned with parseGitHubItemPath; short numbers need a keyword.
// A trailing `.` or `-` only disqualifies when it continues into a word (`#12.txt`,
// `#12-rc`), so a reference that ends a sentence still links.
const GITHUB_ITEM_REF_RE = /#([1-9]\d{0,9})(?!\w|[.-]\w)/g;
const GITHUB_ITEM_KEYWORD_RE = /(PR|pull request|pull|issue|fixes|closes|resolves)\s+$/i;

function referenceTextContexts(children: readonly Token[]) {
  const contexts = new Map<
    Token,
    { run: { content: string; scannedTo: number }; offset: number }
  >();
  let run = { content: "", scannedTo: 0 };
  let linkDepth = 0;
  for (const token of children) {
    if (token.type === "link_open") {
      linkDepth++;
    } else if (token.type === "link_close") {
      linkDepth--;
    }
    if (linkDepth === 0 && token.type === "text") {
      contexts.set(token, { run, offset: run.content.length });
      run.content += token.content;
    } else if (!/^(?:em|strong)_(?:open|close)$/.test(token.type)) {
      // Formatting is transparent to reference semantics, but links, code,
      // images, and line breaks must not lend their text to a nearby keyword.
      run = { content: "", scannedTo: 0 };
    }
  }
  return contexts;
}

export function installMarkdownGitHubRefs(markdownParser: MarkdownIt): void {
  markdownParser.core.ruler.before("web-link-classes", "github-item-refs", (state) => {
    // SAFETY: markdown.ts supplies normalized render options as markdown-it's untyped env.
    const env = state.env as Partial<MarkdownRenderEnv> | undefined;
    const repository = env?.githubRepo;
    if (!repository) {
      return;
    }
    const base = `https://github.com/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}`;
    let inHeading = false;
    for (const blockToken of state.tokens) {
      if (blockToken.type === "heading_open") {
        inHeading = true;
      } else if (blockToken.type === "heading_close") {
        inHeading = false;
      }
      const children = blockToken.children;
      if (inHeading || blockToken.type !== "inline" || !children) {
        continue;
      }
      const contexts = referenceTextContexts(children);
      for (let index = 0; index < children.length; index++) {
        const token = children[index];
        if (!token) {
          continue;
        }
        const context = contexts.get(token);
        if (context) {
          const replacements: Token[] = [];
          let cursor = 0;
          const text = (content: string) => {
            const label = new state.Token("text", "", 0);
            label.content = content;
            replacements.push(label);
          };
          for (const match of token.content.matchAll(GITHUB_ITEM_REF_RE)) {
            const number = match[1];
            if (!number) {
              continue;
            }
            const end = match.index + match[0].length;
            const referenceStart = match.index;
            const startInRun = context.offset + referenceStart;
            const endInRun = context.offset + end;
            const content = context.run.content;
            const prefix = content
              .slice(context.run.scannedTo, startInRun)
              .match(GITHUB_ITEM_KEYWORD_RE);
            // A prior number cannot be part of the next adjacent keyword.
            context.run.scannedTo = endInRun;
            const keyword =
              prefix && hasMarkdownLinkBoundaries(content, startInRun - prefix[0].length, endInRun)
                ? prefix[1]
                : undefined;
            if (
              (!keyword && number.length < 4) ||
              !hasMarkdownLinkBoundaries(content, startInRun, endInRun) ||
              /^[.-]\w/.test(content.slice(endInRun))
            ) {
              continue;
            }
            const path = keyword && /^(?:pr|pull)/i.test(keyword) ? "pull" : "issues";
            const open = new state.Token("link_open", "a", 1);
            open.attrSet("href", `${base}/${path}/${number}`);
            text(token.content.slice(cursor, referenceStart));
            replacements.push(open);
            text(`#${number}`);
            replacements.push(new state.Token("link_close", "a", -1));
            cursor = end;
          }
          if (cursor) {
            text(token.content.slice(cursor));
            children.splice(index, 1, ...replacements);
            index += replacements.length - 1;
          }
        }
      }
    }
  });
}
