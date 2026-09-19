import { html, nothing, render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import "../styles.css";
import { renderCommandPaletteInput } from "./command-palette-input.ts";

const hasBrowserLayout = !navigator.userAgent.toLowerCase().includes("jsdom");
const onInputRef = () => undefined;

describe.skipIf(!hasBrowserLayout)("command palette input layout", () => {
  let host: HTMLDivElement | undefined;

  afterEach(() => {
    if (host) {
      render(nothing, host);
      host.remove();
      host = undefined;
    }
  });

  it("grows down through three lines, keeps actions fixed and fades clear of the far-right scrollbar", async () => {
    host = document.body.appendChild(document.createElement("div"));
    host.style.cssText = "width: 740px; max-width: 100%;";
    render(
      renderCommandPaletteInput({
        value: "One line",
        placeholder: "Search or start a task…",
        onInputRef,
        onValueChange: () => undefined,
        actions: html`<button type="button" class="cmd-palette__create">
          New session<kbd>Ctrl+Enter</kbd>
        </button>`,
      }),
      host,
    );
    const input = host.querySelector("textarea")!;
    const entry = host.querySelector<HTMLElement>(".cmd-palette__entry")!;
    const actions = host.querySelector<HTMLElement>(".cmd-palette__input-actions")!;
    const textScroll = host.querySelector<HTMLElement>(".cmd-palette__input-scroll")!;
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });
    input.dispatchEvent(new Event("input", { bubbles: true }));
    const top = input.getBoundingClientRect().top;
    const actionTop = actions.getBoundingClientRect().top;
    const lineHeight = Number.parseFloat(getComputedStyle(input).lineHeight);
    expect(input.clientHeight).toBe(lineHeight);

    input.value = "One line\nTwo lines";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(input.clientHeight).toBe(lineHeight * 2);
    expect(input.getBoundingClientRect().top).toBe(top);
    expect(actions.getBoundingClientRect().top).toBe(actionTop);

    input.value = "One line\nTwo lines\nThree lines\nFour lines\nFive lines";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(input.clientHeight).toBe(lineHeight * 3);
    expect(input.scrollHeight).toBeGreaterThan(input.clientHeight);
    expect(getComputedStyle(input).overflowY).toBe("auto");
    expect(getComputedStyle(input).scrollbarWidth).not.toBe("none");
    expect(input.getBoundingClientRect().top).toBe(top);
    expect(actions.getBoundingClientRect().top).toBe(actionTop);
    expect(input.getBoundingClientRect().right).toBeGreaterThan(
      actions.getBoundingClientRect().right + 8,
    );
    const textRight =
      input.getBoundingClientRect().right - Number.parseFloat(getComputedStyle(input).paddingRight);
    expect(textRight).toBeLessThan(actions.getBoundingClientRect().left);
    const fadeRight =
      textScroll.getBoundingClientRect().right -
      Number.parseFloat(getComputedStyle(textScroll, "::after").right);
    expect(fadeRight).toBeLessThan(actions.getBoundingClientRect().left);
    // Autofocus keeps an edited caret visible; explicitly inspect the top edge.
    input.scrollTop = 0;
    input.dispatchEvent(new Event("scroll"));
    expect(entry.hasAttribute("data-scroll-fade-bottom")).toBe(true);
    expect(entry.hasAttribute("data-scroll-fade-top")).toBe(false);

    input.scrollTop = input.scrollHeight;
    input.dispatchEvent(new Event("scroll"));
    expect(entry.hasAttribute("data-scroll-fade-top")).toBe(true);
    expect(entry.hasAttribute("data-scroll-fade-bottom")).toBe(false);
    input.scrollTop = 0;
    input.dispatchEvent(new Event("scroll"));
    expect(entry.hasAttribute("data-scroll-fade-top")).toBe(false);
    expect(entry.hasAttribute("data-scroll-fade-bottom")).toBe(true);

    input.value = "A short task";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(input.clientHeight).toBe(lineHeight);
    expect(entry.hasAttribute("data-scroll-fade-top")).toBe(false);
    expect(entry.hasAttribute("data-scroll-fade-bottom")).toBe(false);
    expect(input.getBoundingClientRect().top).toBe(top);

    input.value = "A wrapping task with enough text to grow after the available width changes.";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    host.style.width = "320px";
    await vi.waitFor(() => expect(input.clientHeight).toBe(lineHeight * 3));
    expect(actions.getBoundingClientRect().top).toBe(actionTop);
  });
});
