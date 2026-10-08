import { useCallback, useMemo, useState } from "react";
import { EmptyState, Notice, Switch } from "../../ui";
import { useT } from "../../i18n/shared";
import { readJsonOrThrow } from "../../fetch-json";
import { useDataSurface } from "../../data-surface";
import {
  clientCatalogRefreshFailures,
  putModelVisibility,
} from "../../model-visibility";

/**
 * Codex model selection for the Integrations tab.
 *
 * Every other client on this tab carries its own model switches; Codex did not, because its
 * catalog is written by the proxy rather than into a client-owned config file. The selection
 * itself is not Codex-specific: `/api/model-visibility` writes the server-side state and
 * converges the visible catalogs, so this panel drives the same state from the tab where the
 * operator already is.
 *
 * The switch state comes from `/api/models`, NOT from `/api/selected-models`. A model can be
 * off for two independent reasons — its row carries `disabled`, or a non-empty
 * `selectedModels` allowlist omits it — and reading only the allowlist renders every row as ON
 * while the server has it off, which makes "All off" look like it did nothing. Both signals are
 * combined here so the switch always shows what the server will actually do.
 */

interface ModelRow {
  id: string;
  provider: string;
  native?: boolean;
  disabled?: boolean;
  contextWindow?: number;
}

interface SelectionResponse {
  rows: ModelRow[];
  selected: Record<string, string[]>;
}

interface ProviderGroup {
  provider: string;
  rows: ModelRow[];
}

export default function CodexModelsPanel({ apiBase, active = true }: { apiBase: string; active?: boolean }) {
  const t = useT();
  const [pending, setPending] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [query, setQuery] = useState("");

  const fetchSelection = useCallback(async (signal: AbortSignal): Promise<SelectionResponse> => {
    const [rowsResponse, selectedResponse] = await Promise.all([
      fetch(`${apiBase}/api/models`, { signal }),
      fetch(`${apiBase}/api/selected-models`, { signal }),
    ]);
    const rows = await readJsonOrThrow<ModelRow[]>(rowsResponse, t("integrations.codex.modelsFail"));
    const selectedPayload = await readJsonOrThrow<{ selected?: Record<string, string[]> }>(
      selectedResponse,
      t("integrations.codex.modelsFail"),
    );
    if (!Array.isArray(rows) || !selectedPayload) {
      throw new Error(t("integrations.codex.modelsFail"));
    }
    return { rows, selected: selectedPayload.selected ?? {} };
  }, [apiBase, t]);

  const resource = useDataSurface<SelectionResponse>(
    `codex-model-selection:${apiBase}`,
    [apiBase],
    fetchSelection,
    { isEmpty: () => false, staleAfterMs: 30_000, enabled: active },
  );
  const selection = resource.state.data;
  const load = resource.refresh;

  /** The single source of truth for a switch: off if disabled, or omitted by a non-empty allowlist. */
  const enabled = useCallback((row: ModelRow, selected: Record<string, string[]>) => {
    if (row.disabled === true) return false;
    if (row.native === true) return true;
    const allowlist = selected[row.provider];
    if (!allowlist || allowlist.length === 0) return true;
    return allowlist.includes(row.id);
  }, []);

  const groups = useMemo<ProviderGroup[]>(() => {
    const needle = query.trim().toLowerCase();
    const byProvider = new Map<string, ModelRow[]>();
    for (const row of selection?.rows ?? []) {
      if (needle && !row.id.toLowerCase().includes(needle) && !row.provider.toLowerCase().includes(needle)) continue;
      const bucket = byProvider.get(row.provider);
      if (bucket) bucket.push(row);
      else byProvider.set(row.provider, [row]);
    }
    return [...byProvider.entries()]
      .map(([provider, rows]) => ({ provider, rows }))
      .sort((a, b) => a.provider.localeCompare(b.provider));
  }, [selection, query]);

  const apply = useCallback(async (provider: string, ids: string[], nextEnabled: boolean) => {
    setPending(`${provider}:${nextEnabled ? "on" : "off"}`);
    setMessage(null);
    try {
      const response = await putModelVisibility(
        apiBase,
        "models",
        provider,
        ids.map(id => ({ id })),
        nextEnabled,
      );
      const body = await response.json().catch(() => null) as { error?: string } | null;
      if (!response.ok) {
        setMessage({ tone: "err", text: body?.error ?? t("integrations.codex.modelsFail") });
        return;
      }
      // The endpoint converges catalogs in the same call, so a client that refused the refresh
      // is still serving its previous list. That is a real outcome, not a silent success.
      const refused = clientCatalogRefreshFailures(body);
      setMessage(refused?.length
        ? { tone: "err", text: refused.map(row => row.reason || row.refusalReason).filter(Boolean).join(", ") }
        : { tone: "ok", text: t("models.staleBanner") });
      // Re-read before the switch is trusted again: the optimistic value and the server's can
      // disagree, and a switch left showing the wrong state is what made this panel unusable.
      await load();
    } catch {
      setMessage({ tone: "err", text: t("integrations.codex.modelsFail") });
    } finally {
      setPending(null);
    }
  }, [apiBase, load, t]);

  const body = () => {
    if (resource.state.error) return <EmptyState title={t("integrations.codex.modelsFail")} />;
    if (!selection) return <div className="integration-model-empty" />;
    if (groups.length === 0) return <EmptyState title={t("models.search")} />;
    return (
      <>
        <div className="integration-model-toolbar">
          <input
            className="input"
            type="search"
            value={query}
            placeholder={t("models.search")}
            aria-label={t("models.search")}
            onChange={event => setQuery(event.target.value)}
          />
        </div>
        <p className="text-caption muted">{t("models.allowlistHint")}</p>
        <div className="integration-model-list">
          {groups.map(group => {
            const rows = group.rows;
            const onCount = rows.filter(row => enabled(row, selection.selected)).length;
            return (
              <section key={group.provider} className="integration-model-card">
                <header className="integration-model-head">
                  <h3 title={group.provider}>{group.provider}</h3>
                  <div className="integration-model-actions">
                    <span className="text-caption muted">{onCount}/{rows.length}</span>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm text-caption"
                      disabled={pending !== null || onCount === rows.length}
                      onClick={() => void apply(group.provider, rows.filter(row => !enabled(row, selection.selected)).map(row => row.id), true)}
                    >
                      {t("models.allOn")}
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm text-caption"
                      disabled={pending !== null || onCount === 0}
                      onClick={() => void apply(group.provider, rows.filter(row => enabled(row, selection.selected)).map(row => row.id), false)}
                    >
                      {t("models.allOff")}
                    </button>
                  </div>
                </header>
                <div className="integration-model-rows">
                  {rows.map(row => {
                    const on = enabled(row, selection.selected);
                    return (
                      <div key={`${row.provider}/${row.id}`} className="integration-model-row">
                        <Switch
                          on={on}
                          onClick={() => void apply(group.provider, [row.id], !on)}
                          disabled={pending !== null || row.native === true}
                          label={row.id}
                        />
                        <span className="integration-model-name" title={row.id}>{row.id}</span>
                      </div>
                    );
                  })}
                </div>
              </section>
            );
          })}
        </div>
      </>
    );
  };

  return (
    <section className="integration-model-panel">
      <h2>{t("models.tab.catalog")}</h2>
      {message && <Notice tone={message.tone}>{message.text}</Notice>}
      {body()}
    </section>
  );
}