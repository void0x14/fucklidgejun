import { useEffect, useRef, useState } from "react";
import { PROVIDER_KEY_STRATEGIES, type ProviderKeyStrategy } from "../../../../src/types/provider";
import { useT, type TKey } from "../../i18n/shared";
import { createBoundedFetch } from "../../bounded-fetch";
import { readJsonOrThrow } from "../../fetch-json";
import { Notice, Select } from "../../ui";
import type { WorkspaceItem, ApiKeyRow, ProviderUpdatePatch, ProviderUpdateResult } from "./types";

const LABELS: Record<ProviderKeyStrategy, TKey> = {
  failover: "pws.strategy.smart", "round-robin": "pws.strategy.roundRobin", random: "pws.strategy.random",
  "least-used": "pws.strategy.leastUsed", "reset-window": "pws.strategy.resetWindow",
  "fill-first": "pws.strategy.fillFirst", quota: "pws.strategy.quota",
};
const HINTS: Record<ProviderKeyStrategy, TKey> = {
  failover: "pws.strategy.failoverHint", "round-robin": "pws.strategy.roundRobinHint",
  random: "pws.strategy.randomHint", "least-used": "pws.strategy.leastUsedHint",
  "reset-window": "pws.strategy.resetWindowHint", "fill-first": "pws.strategy.fillFirstHint", quota: "pws.strategy.quotaHint",
};

export default function ProviderStrategy({ item, apiBase, supported, onUpdateProvider }: {
  item: WorkspaceItem; apiBase: string; supported: boolean;
  onUpdateProvider?: (name: string, patch: ProviderUpdatePatch) => Promise<ProviderUpdateResult>;
}) {
  const t = useT();
  const [strategy, setStrategy] = useState<ProviderKeyStrategy>(item.apiKeyPoolStrategy ?? "failover");
  const [keys, setKeys] = useState<ApiKeyRow[] | null>(null);
  const [observedAt, setObservedAt] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [reload, setReload] = useState(0);
  const alive = useRef(false);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  useEffect(() => {
    if (!supported) return;
    let cancelled = false;
    const bounded = createBoundedFetch(20_000);
    void fetch(`${apiBase}/api/providers/keys?name=${encodeURIComponent(item.name)}`, { signal: bounded.signal })
      .then(readJsonOrThrow<{ keys: ApiKeyRow[] }>).then(data => {
        if (!Array.isArray(data?.keys)) throw new Error();
        if (!cancelled) { setKeys(data.keys); setObservedAt(Date.now()); setError(""); }
      }).catch(e => {
        if (!cancelled) setError(e instanceof Error && e.message ? e.message : t("pws.strategy.loadFailed"));
      }).finally(() => bounded.clear());
    const timer = setTimeout(() => { if (!cancelled) setReload(n => n + 1); }, 15_000);
    return () => { cancelled = true; bounded.controller.abort(); bounded.clear(); clearTimeout(timer); };
  }, [apiBase, item.name, supported, reload, t]);

  const save = async (value: string) => {
    if (saving || !onUpdateProvider) return;
    setSaving(true); setError(""); setSaved(false);
    try {
      const result = await onUpdateProvider(item.name, { apiKeyPoolStrategy: value as ProviderKeyStrategy });
      if (!result.ok) throw new Error(result.error || t("pws.strategy.saveFailed"));
      if (alive.current) { setStrategy(value as ProviderKeyStrategy); setSaved(true); }
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : t("pws.strategy.saveFailed"));
    } finally { if (alive.current) setSaving(false); }
  };

  return <div className="pws-section">
    <div className="pws-section-head"><h3 className="pws-section-title">{t("pws.tab.strategy")}</h3></div>
    {!supported ? <Notice tone="warn">{t("pws.strategy.keyOnly")}</Notice> : <>
      <p className="muted">{t("pws.strategy.intro")}</p>
      <label className="field-label" htmlFor="provider-key-strategy">{t("pws.tab.strategy")}</label>
      <Select id="provider-key-strategy" value={strategy}
        options={PROVIDER_KEY_STRATEGIES.filter(value => value !== "fill-first" && value !== "quota" || value === strategy)
          .map(value => ({ value, label: t(LABELS[value]) }))}
        onChange={value => { void save(value); }} disabled={saving || !onUpdateProvider || keys === null} align="left" />
      <p className="muted" style={{ marginTop: 12 }}>{t(HINTS[strategy])}</p>
      {saving && <p role="status">{t("common.saving")}</p>}
      {saved && <Notice tone="ok">{t("operation.saved")}</Notice>}
      {error && <Notice tone="err">{error}</Notice>}
      <div className="pws-section-head" style={{ marginTop: 24 }}>
        <h3 className="pws-section-title">{t("pws.strategy.health")}</h3>
        <button className="btn btn-ghost btn-sm" type="button" onClick={() => setReload(n => n + 1)}>{t("common.retry")}</button>
      </div>
      <p className="muted">{t("pws.strategy.healthHint")}</p>
      {keys === null ? <p role="status">{t("common.loading")}</p>
        : keys.length === 0 ? <Notice tone="warn">{t("pws.strategy.noKeys")}</Notice>
        : <div style={{ overflowX: "auto" }}><table className="table" style={{ width: "100%" }}>
          <thead><tr><th>{t("pws.apiKeys")}</th><th>{t("pws.strategy.state")}</th><th>{t("pws.strategy.accepted")}</th>
            <th>{t("pws.strategy.failed")}</th><th>{t("pws.strategy.score")}</th></tr></thead>
          <tbody>{keys.map(key => {
            const cooling = (key.health?.cooldownUntil ?? 0) > observedAt;
            const observed = (key.health?.successes ?? 0) + (key.health?.failures ?? 0) > 0;
            return <tr key={key.id}><td>{key.label || key.masked}</td>
              <td>{t(cooling ? "pws.strategy.cooling" : observed ? "pws.strategy.observed" : "pws.strategy.unknown")}</td>
              <td>{key.health?.successes ?? 0}</td><td>{key.health?.failures ?? 0}</td>
              <td>{observed ? `${Math.round((key.health?.reliability ?? 0.5) * 100)}%` : "—"}</td></tr>;
          })}</tbody>
        </table></div>}
      <p className="muted" style={{ marginTop: 20 }}>{t("pws.strategy.boundary")}</p>
    </>}
  </div>;
}
