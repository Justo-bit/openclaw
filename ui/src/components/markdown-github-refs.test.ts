import { describe, expect, it } from "vitest";
import { toSanitizedMarkdownHtml, toStreamingMarkdownParts } from "./markdown.ts";

function htmlFragment(html: string): HTMLElement {
  const container = document.createElement("div");
  container.innerHTML = html;
  return container;
}

describe("github item references", () => {
  const githubRepo = { owner: "openclaw", repo: "openclaw" };

  it("leaves references plain without a repository", () => {
    const fragment = htmlFragment(toSanitizedMarkdownHtml("PR #141270 issue #123 #141270"));
    expect(fragment.querySelector("a")).toBeNull();
  });

  it.each([
    ["PR #141270", "PR ", "141270", "pull"],
    ["issue #123", "issue ", "123", "issue"],
    ["#141270", "", "141270", "issue"],
    ["pull request #123", "pull request ", "123", "pull"],
    ["PuLl #123", "PuLl ", "123", "pull"],
    ["pr #1", "pr ", "1", "pull"],
    ["fixes #123", "fixes ", "123", "issue"],
    ["Closes #123", "Closes ", "123", "issue"],
    ["resolves #123", "resolves ", "123", "issue"],
    ["#1000", "", "1000", "issue"],
    ["reissue #141270", "reissue ", "141270", "issue"],
    ["issue #9999999999", "issue ", "9999999999", "issue"],
  ])("renders %s through the existing GitHub chip classifier", (input, prefix, number, kind) => {
    const fragment = htmlFragment(toSanitizedMarkdownHtml(input, { githubRepo }));
    const anchor = fragment.querySelector<HTMLAnchorElement>("a.markdown-github-item");
    const href = `https://github.com/openclaw/openclaw/${kind === "pull" ? "pull" : "issues"}/${number}`;
    expect(anchor?.getAttribute("href")).toBe(href);
    expect(anchor?.classList.contains("markdown-github-link")).toBe(true);
    expect(anchor?.dataset.githubKind).toBe(kind);
    expect(anchor?.textContent).toBe(`#${number}`);
    expect(anchor?.hasAttribute("title")).toBe(false);
    expect(anchor?.previousSibling?.textContent ?? "").toBe(prefix);
    expect(fragment.textContent).toBe(`${input}\n`);
  });

  it.each([
    "#3",
    "#42",
    "#fff",
    "#1a2b3c",
    "C#",
    "#general",
    "#01234",
    "PR #0123",
    "#12345678901",
    "issue #12345678901",
    "#141270suffix",
    "#141270-suffix",
    "#141270.txt",
    "word#141270",
    "`PR #141270`",
    "```text\nPR #141270\n```",
    "[PR #141270](https://example.test)",
    "# PR #141270",
    "PR #141270\n===========",
    "https://example.test/path#141270",
    "/path#141270",
  ])("does not infer an item from %j", (input) => {
    const fragment = htmlFragment(
      toSanitizedMarkdownHtml(input, { githubRepo, fileLinks: true, sessionLinks: true }),
    );
    expect(fragment.querySelector("a.markdown-github-item")).toBeNull();
    expect(fragment.querySelector("a a")).toBeNull();
  });

  it.each([
    ["PR **#1576 opened**", "PR #1576 opened", "1576", "pull"],
    ["**PR** #42", "PR #42", "42", "pull"],
    ["pull **request** *#42*", "pull request #42", "42", "pull"],
    ["**pull** request **#42**", "pull request #42", "42", "pull"],
    ["*issue* **#42**", "issue #42", "42", "issue"],
    ["**closes** *#42*", "closes #42", "42", "issue"],
  ])("preserves the item kind across emphasis in %s", (input, label, number, kind) => {
    const fragment = htmlFragment(toSanitizedMarkdownHtml(input, { githubRepo }));
    const anchor = fragment.querySelector<HTMLAnchorElement>("a.markdown-github-item");
    expect(anchor?.getAttribute("href")).toBe(
      `https://github.com/openclaw/openclaw/${kind === "pull" ? "pull" : "issues"}/${number}`,
    );
    expect(anchor?.dataset.githubKind).toBe(kind);
    expect(anchor?.textContent).toBe(`#${number}`);
    expect(fragment.textContent?.trim()).toBe(label);
    expect(fragment.querySelector("strong, em")).not.toBeNull();
  });

  it.each([
    "re**PR** #42",
    "**PR**fix #42",
    "PR **#42**suffix",
    "PR **#42**.txt",
    "PR `code` **#42**",
    "`PR` **#42**",
    "[PR](https://example.test) **#42**",
    "PR ![image](https://example.test/image.png) **#42**",
    "PR\n\n**#42**",
  ])("does not carry keyword context across non-emphasis boundaries in %s", (input) => {
    const fragment = htmlFragment(toSanitizedMarkdownHtml(input, { githubRepo }));
    expect(fragment.querySelector("a.markdown-github-item")).toBeNull();
  });

  it("keeps punctuation and keywords outside adjacent chips and resumes after headings and links", () => {
    const input =
      "# PR #141270\n\n(PR #141270), issue #123; [#141270](https://example.test) and #141271!";
    const fragment = htmlFragment(toSanitizedMarkdownHtml(input, { githubRepo }));
    const anchors = fragment.querySelectorAll("a.markdown-github-item");
    expect([...anchors].map((anchor) => anchor.textContent)).toEqual([
      "#141270",
      "#123",
      "#141271",
    ]);
    expect(fragment.querySelector("p")?.textContent).toBe(
      "(PR #141270), issue #123; #141270 and #141271!",
    );
    expect(fragment.querySelector("h1 a")).toBeNull();
  });

  it.each([
    ["Fixed PR #141270.", "pull", "#141270"],
    ["See issue #123.", "issue", "#123"],
    ["Landed as #141270.", "issue", "#141270"],
    ["Closes #123: done.", "issue", "#123"],
  ])("links a reference that ends a sentence in %j", (input, kind, label) => {
    const fragment = htmlFragment(toSanitizedMarkdownHtml(input, { githubRepo }));
    const anchor = fragment.querySelector("a.markdown-github-item");
    expect(anchor?.textContent).toBe(label);
    expect(anchor?.getAttribute("data-github-kind")).toBe(kind);
    expect(fragment.querySelector("p")?.textContent).toBe(input);
  });

  it.each(["PR #141270", "PR **#141270**", "**PR** #141270"])(
    "encodes repository path segments in streaming %s",
    (source) => {
      const options = { githubRepo: { owner: "some owner", repo: "repo/name" } };
      const fragment = htmlFragment(toStreamingMarkdownParts(source, options).join(""));
      expect(fragment.querySelector("a")?.getAttribute("href")).toBe(
        "https://github.com/some%20owner/repo%2Fname/pull/141270",
      );
    },
  );
});
