import { html, nothing, type TemplateResult } from "lit";
import { AsyncDirective } from "lit/async-directive.js";
import { directive, type ElementPart } from "lit/directive.js";
import { ref } from "lit/directives/ref.js";

export const COMMAND_PALETTE_INPUT_ID = "cmd-palette-input";

type CommandPaletteInputProps = {
  value: string;
  placeholder: string;
  onInputRef: (element: Element | undefined) => void;
  onValueChange: (value: string) => void;
  actions?: TemplateResult | typeof nothing;
  disabled?: boolean;
  readOnly?: boolean;
  controls?: string;
  activeDescendant?: string;
  describedBy?: string;
};

function updatePaletteInputOverflow(textarea: HTMLTextAreaElement) {
  const root = textarea.closest(".cmd-palette__entry");
  const overflow = textarea.scrollHeight - textarea.clientHeight;
  root?.toggleAttribute("data-scroll-fade-top", overflow > 1 && textarea.scrollTop > 1);
  root?.toggleAttribute(
    "data-scroll-fade-bottom",
    overflow > 1 && textarea.scrollTop < overflow - 1,
  );
}

// This input is also the cold-loader surface. Keep its DOM/layout owner free of
// search catalogs, draft creation, and the full chat composer's scroll lifecycle.
function updatePaletteInputLayout(textarea: HTMLTextAreaElement) {
  const root = textarea.closest<HTMLElement>(".cmd-palette__entry");
  const actions = root?.querySelector<HTMLElement>(".cmd-palette__input-actions");
  if (root && actions) {
    root.style.setProperty(
      "--cmd-palette-actions-width",
      `${actions.getBoundingClientRect().width}px`,
    );
  }
  const lineHeight = Number.parseFloat(getComputedStyle(textarea).lineHeight);
  if (!Number.isFinite(lineHeight) || lineHeight <= 0) {
    return;
  }
  const previousScroll = textarea.scrollTop;
  const followCaret =
    document.activeElement === textarea &&
    textarea.selectionStart === textarea.selectionEnd &&
    textarea.selectionEnd === textarea.value.length;
  textarea.style.overflowY = "hidden";
  textarea.style.height = "0px";
  textarea.style.height = `${Math.max(lineHeight, Math.min(lineHeight * 3, textarea.scrollHeight))}px`;
  const overflowing = textarea.scrollHeight > textarea.clientHeight + 1;
  textarea.style.overflowY = overflowing ? "auto" : "hidden";
  textarea.scrollTop = overflowing ? (followCaret ? textarea.scrollHeight : previousScroll) : 0;
  updatePaletteInputOverflow(textarea);
}

class PaletteInputLayoutDirective extends AsyncDirective {
  #textarea: HTMLTextAreaElement | undefined;
  #observer: ResizeObserver | undefined;
  #frame: number | undefined;
  #listening = false;

  render(_value: string) {
    return nothing;
  }

  override update(part: ElementPart, [_value]: [string]) {
    this.#textarea = part.element instanceof HTMLTextAreaElement ? part.element : undefined;
    this.#scheduleLayout();
    return nothing;
  }

  readonly #updateOverflow = () => {
    if (this.#textarea) {
      updatePaletteInputOverflow(this.#textarea);
    }
  };

  readonly #scheduleLayout = () => {
    if (this.#frame !== undefined) {
      return;
    }
    this.#frame = requestAnimationFrame(() => {
      this.#frame = undefined;
      if (this.isConnected && this.#textarea?.isConnected) {
        this.#connect();
        updatePaletteInputLayout(this.#textarea);
      }
    });
  };

  #connect() {
    const textarea = this.#textarea;
    if (!this.isConnected || !textarea || this.#listening) {
      return;
    }
    this.#listening = true;
    textarea.addEventListener("scroll", this.#updateOverflow, { passive: true });
    if (typeof ResizeObserver === "function") {
      // The frame guard coalesces size changes; an unchanged final box settles
      // observation without a separate cache of element widths.
      this.#observer = new ResizeObserver(this.#scheduleLayout);
      const root = textarea.closest(".cmd-palette__entry");
      if (root) {
        this.#observer.observe(root);
        const actions = root.querySelector(".cmd-palette__input-actions");
        if (actions) {
          this.#observer.observe(actions);
        }
      }
    }
  }

  protected override disconnected() {
    this.#textarea?.removeEventListener("scroll", this.#updateOverflow);
    this.#observer?.disconnect();
    this.#observer = undefined;
    this.#listening = false;
    if (this.#frame !== undefined) {
      cancelAnimationFrame(this.#frame);
      this.#frame = undefined;
    }
  }

  protected override reconnected() {
    this.#connect();
    this.#scheduleLayout();
  }
}

const paletteInputLayout = directive(PaletteInputLayoutDirective);

export function renderCommandPaletteInput(props: CommandPaletteInputProps) {
  return html`
    <div class="cmd-palette__entry">
      <div class="cmd-palette__input-scroll">
        <textarea
          ${paletteInputLayout(props.value)}
          autofocus
          rows="1"
          id=${COMMAND_PALETTE_INPUT_ID}
          class="cmd-palette__input"
          aria-label=${props.placeholder}
          aria-autocomplete=${props.controls ? "list" : nothing}
          aria-controls=${props.controls ?? nothing}
          aria-activedescendant=${props.activeDescendant ?? nothing}
          aria-describedby=${props.describedBy ?? nothing}
          placeholder=${props.placeholder}
          .value=${props.value}
          ?disabled=${props.disabled}
          ?readonly=${props.readOnly}
          ${ref(props.onInputRef)}
          @input=${(event: Event) => {
            if (event.currentTarget instanceof HTMLTextAreaElement) {
              props.onValueChange(event.currentTarget.value);
              updatePaletteInputLayout(event.currentTarget);
            }
          }}
        ></textarea>
      </div>
      <div class="cmd-palette__input-actions">${props.actions ?? nothing}</div>
    </div>
  `;
}
