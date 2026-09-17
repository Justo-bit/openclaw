import { html, nothing, type ReactiveControllerHost } from "lit";
import type { ApplicationContext } from "../../app/context.ts";
import { icons } from "../../components/icons.ts";
import { hasProviderBrandIcon, renderProviderBrandIcon } from "../../components/provider-icon.ts";
import {
  renderSettingsEmpty,
  renderSettingsLoadingSkeleton,
  renderSettingsSection,
  renderSettingsStatus,
  renderSettingsToggleRow,
} from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import type { GatewayPageController } from "../../lit/gateway-page-controller.ts";
import {
  modelProviderConfigMutationBlockedReason,
  modelProviderErrorMessage,
  runModelProviderConfigMutation,
  type ModelProviderRowMessage,
} from "./config-mutation.ts";
import type { ModelProviderCard } from "./data.ts";

const INSTALLED_AGENTS_METHOD = "acpx.agents.list";

type InstalledAgent = {
  id: string;
  name: string;
  runtimeId: string;
  installation: "installed" | "missing" | "unverified";
  enabled: boolean;
};

const INSTALLATION_STATUS = {
  installed: { kind: "ok", labelKey: "modelProviders.installedAgents.status.installed" },
  missing: { kind: "muted", labelKey: "modelProviders.installedAgents.status.missing" },
  unverified: { kind: "warn", labelKey: "modelProviders.installedAgents.status.unverified" },
} as const;

type InstalledAgentsOptions = {
  gateway: GatewayPageController;
  getContext: () => ApplicationContext;
  isConfigBusy: () => boolean;
  refreshModels: () => Promise<void>;
};

export class InstalledAgentsController {
  private agents: InstalledAgent[] | null = null;
  private loading = false;
  private error: string | null = null;
  /** Gateway epoch whose read settled; a reconnect needs a fresh read. */
  private settledEpoch: number | null = null;
  private generation = 0;
  /** Requested enabled state per agent while its config write is unsettled. */
  private readonly pending = new Map<string, boolean>();
  private readonly messages = new Map<string, ModelProviderRowMessage>();

  constructor(
    private readonly host: ReactiveControllerHost,
    private readonly options: InstalledAgentsOptions,
  ) {}

  subscribe(gateway: ApplicationContext["gateway"]): () => void {
    return gateway.subscribeEvents((event) => {
      if (event.event === "config.changed") {
        this.handleConfigChanged();
      }
    });
  }

  /** Writes from a previous connection cannot settle here, so their state goes too. */
  reset(options: { preserveVisibleData?: boolean } = {}): void {
    this.generation += 1;
    this.loading = false;
    this.error = null;
    this.settledEpoch = null;
    this.pending.clear();
    this.messages.clear();
    if (!options.preserveVisibleData) {
      this.agents = null;
    }
  }

  ensureLoaded(): void {
    const gateway = this.options.gateway;
    if (gateway.connected && !this.loading && this.settledEpoch !== gateway.epoch) {
      void this.load();
    }
  }

  filterProviders(cards: ModelProviderCard[]): ModelProviderCard[] {
    return cards.filter((card) => !this.agents?.some((agent) => agent.runtimeId === card.id));
  }

  /** Another client's config write can change enabled flags. */
  private handleConfigChanged(): void {
    if (this.agents !== null && this.pending.size === 0) {
      void this.load();
    }
  }

  private available(): boolean {
    return canCallGatewayMethod(
      this.options.getContext().gateway.snapshot,
      INSTALLED_AGENTS_METHOD,
      "operator.read",
    );
  }

  private async load(): Promise<void> {
    const scope = this.options.gateway.capture();
    if (!scope || !this.available()) {
      return;
    }
    const generation = ++this.generation;
    const owns = () => this.generation === generation && this.options.gateway.isCurrent(scope);
    this.loading = true;
    this.error = null;
    this.host.requestUpdate();
    try {
      const result = await scope.client.request<{ agents: InstalledAgent[] }>(
        INSTALLED_AGENTS_METHOD,
        {},
      );
      if (owns()) {
        this.agents = result.agents;
      }
    } catch (error) {
      if (owns()) {
        this.error = modelProviderErrorMessage(error);
      }
    } finally {
      if (owns()) {
        this.loading = false;
        this.settledEpoch = scope.epoch;
        this.host.requestUpdate();
      }
    }
  }

  private blockedReason(): string | null {
    return modelProviderConfigMutationBlockedReason(this.options.getContext());
  }

  private setEnabled(agent: InstalledAgent, enabled: boolean): boolean {
    const scope = this.options.gateway.capture();
    if (
      !scope ||
      this.blockedReason() ||
      this.options.isConfigBusy() ||
      this.pending.has(agent.id)
    ) {
      return false;
    }
    // The requested state shows until the post-write read, whose newer generation
    // discards any list read that started before this write.
    this.pending.set(agent.id, enabled);
    const isCurrent = () => this.options.gateway.isCurrent(scope);
    void runModelProviderConfigMutation(
      {
        runtimeConfig: this.options.getContext().runtimeConfig,
        agentEpoch: 0,
        isCurrentClient: isCurrent,
        isCurrentAgent: () => true,
        refreshProviders: this.options.refreshModels,
        // Pending state settles after the authoritative list read below.
        setBusy: () => this.host.requestUpdate(),
        setMessage: (message) => {
          if (message) {
            this.messages.set(agent.id, message);
          } else {
            this.messages.delete(agent.id);
          }
          this.host.requestUpdate();
        },
      },
      {
        key: `installed-agent:${agent.id}`,
        raw: {
          plugins: { entries: { acpx: { config: { nativeAgents: { [agent.id]: enabled } } } } },
        },
        note: t("modelProviders.installedAgents.note"),
      },
    ).then(async (result) => {
      if (!isCurrent()) {
        return;
      }
      if (result.ok) {
        this.agents =
          this.agents?.map((entry) => (entry.id === agent.id ? { ...entry, enabled } : entry)) ??
          null;
      }
      await this.load();
      if (isCurrent()) {
        this.pending.delete(agent.id);
        this.host.requestUpdate();
      }
    });
    return true;
  }

  private renderAgent(agent: InstalledAgent, blocked: boolean) {
    const pending = this.pending.get(agent.id);
    const status = INSTALLATION_STATUS[agent.installation];
    const message = this.messages.get(agent.id);
    return html`
      <div class="model-providers__installed-agent" data-installed-agent=${agent.id}>
        ${renderSettingsToggleRow({
          icon: hasProviderBrandIcon(agent.id)
            ? renderProviderBrandIcon(agent.id, { className: "model-providers__icon" })
            : html`<span
                class="model-providers__icon model-providers__agent-icon"
                aria-hidden="true"
                >${icons.terminal}</span
              >`,
          title: agent.name,
          ariaLabel: t("modelProviders.installedAgents.toggle", { name: agent.name }),
          description:
            pending === undefined
              ? html`<span
                  title=${
                    agent.installation === "unverified"
                      ? t("modelProviders.installedAgents.unverifiedHint")
                      : nothing
                  }
                  >${renderSettingsStatus({ kind: status.kind, label: t(status.labelKey) })}</span
                >`
              : renderSettingsStatus({ kind: "muted", label: t("modelProviders.saving") }),
          checked: pending ?? agent.enabled,
          disabled: blocked || pending !== undefined,
          onChange: (checked) => this.setEnabled(agent, checked),
        })}
        ${
          message
            ? html`<div
                class="callout ${message.kind} model-providers__installed-agent-message"
                role=${message.kind === "error" ? "alert" : "status"}
              >
                ${message.text}
              </div>`
            : nothing
        }
      </div>
    `;
  }

  render() {
    if (!this.available()) {
      return nothing;
    }
    const blockedReason = this.blockedReason();
    const blocked = blockedReason !== null || this.options.isConfigBusy();
    const errorRow = this.error
      ? html`<div class="settings-row">
          <div class="settings-row__text">
            <span class="settings-row__desc provider-usage-error" role="alert">${this.error}</span>
          </div>
          <div class="settings-row__control">
            <button class="btn btn--sm" ?disabled=${this.loading} @click=${() => void this.load()}>
              ${t("common.retry")}
            </button>
          </div>
        </div>`
      : nothing;
    const rows =
      this.agents === null
        ? this.error
          ? errorRow
          : renderSettingsLoadingSkeleton({ rows: 4 })
        : html`${errorRow}${
            this.agents.length === 0
              ? renderSettingsEmpty(t("modelProviders.installedAgents.empty"))
              : this.agents.map((agent) => this.renderAgent(agent, blocked))
          }`;
    const checkLabel = this.loading
      ? t("modelProviders.installedAgents.checking")
      : t("modelProviders.installedAgents.check");
    return html`
      <div class="model-providers__installed-agents">
        ${renderSettingsSection(
          {
            title: t("modelProviders.installedAgents.title"),
            description: html`${t("modelProviders.installedAgents.description")}${
              blockedReason ? html`<br />${blockedReason}` : nothing
            }`,
            actions: html`
              <openclaw-tooltip .content=${checkLabel}>
                <button
                  type="button"
                  class="btn btn--icon btn--ghost btn--xs model-providers__refresh-button"
                  aria-label=${checkLabel}
                  ?disabled=${this.loading || this.pending.size > 0}
                  @click=${() => void this.load()}
                >
                  ${icons.refresh}
                </button>
              </openclaw-tooltip>
            `,
          },
          rows,
        )}
      </div>
    `;
  }
}
