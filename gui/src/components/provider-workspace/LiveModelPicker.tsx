import { useEffect, useState } from "react";
import { useT } from "../../i18n/shared";
import { readJsonOrThrow } from "../../fetch-json";
import { createBoundedFetch } from "../../bounded-fetch";
import { canonicalModelId } from "../../../../src/providers/model-id";
import type { WorkspaceItem, ProviderUpdatePatch, ProviderUpdateResult } from "./types";

type Catalog = { models: string[]; source: "live" | "cached" | "preset" | "unavailable"; message?: string };

/** Gerçek kimliği seçtirir; hazır veya eski listeyi canlı sonuç diye göstermez. */
export default function LiveModelPicker({ item, apiBase, draft, onPick, onCatalog, onUpdateProvider }: {
  item: WorkspaceItem; apiBase: string; draft: string; onPick: (id: string) => void;
  onCatalog: (ids: string[]) => void;
  onUpdateProvider?: (name: string, patch: ProviderUpdatePatch) => Promise<ProviderUpdateResult>;
}) {
  const t = useT();
  const [epoch, setEpoch] = useState(0);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (item.liveModels === false && epoch === 0) return;
    let cancelled = false;
    const bounded = createBoundedFetch(30_000);
    const timer = setTimeout(() => { if (!cancelled) setLoading(true); }, 0);
    void fetch(`${apiBase}/api/model-discovery?catalog=1&provider=${encodeURIComponent(item.name)}${epoch ? "&refresh=1" : ""}`, { signal: bounded.signal })
      .then(readJsonOrThrow<Catalog>).then(data => {
        if (!data || !Array.isArray(data.models) || data.models.some(id => typeof id !== "string")
          || !["live", "cached", "preset", "unavailable"].includes(data.source)) throw new Error();
        if (cancelled) return;
        if (data.source !== "unavailable") { setCatalog(data); onCatalog(data.models); }
        setMessage(data.message ?? "");
      }).catch(() => { if (!cancelled) setMessage(t("pws.discovery.failed")); })
      .finally(() => { bounded.clear(); clearTimeout(timer); if (!cancelled) setLoading(false); });
    return () => { cancelled = true; clearTimeout(timer); bounded.controller.abort(); bounded.clear(); };
  }, [apiBase, item.name, item.liveModels, epoch, onCatalog, t]);
  const ids = catalog?.models ?? [];
  const canonical = canonicalModelId(draft, item.name, ids);
  const matches = ids.filter(id => !draft.trim() || id.toLowerCase().includes(draft.trim().toLowerCase()));
  const suggestions = (matches.length ? matches : ids).slice(0, 20);
  const setDefault = async () => {
    if (!canonical || saving || !onUpdateProvider) return;
    setSaving(true); setMessage("");
    try {
      const result = await onUpdateProvider(item.name, { defaultModel: canonical });
      setMessage(result.ok ? t("operation.saved") : result.error || t("pws.discovery.saveFailed"));
    } catch { setMessage(t("pws.discovery.saveFailed")); }
    finally { setSaving(false); }
  };
  return <div style={{ margin: "16px 0" }}>
    <div className="row">
      <button type="button" className="btn btn-ghost btn-sm" disabled={loading} onClick={() => setEpoch(n => n + 1)}>
        {t(loading ? "pws.discovery.loading" : "pws.discovery.refresh")}</button>
      {catalog && <span className="muted text-label">{t(`pws.discovery.${catalog.source}`)}</span>}
    </div>
    {item.liveModels === false && !catalog && <p className="muted text-label">{t("pws.discovery.manual")}</p>}
    {message && <p className="muted text-label" role="status">{message}</p>}
    {!!suggestions.length && <>
      <p className="muted text-label">{t("pws.discovery.pick")}</p>
      <div className="row" style={{ flexWrap: "wrap" }}>{suggestions.map(id => <button type="button" className="btn btn-ghost btn-sm"
        key={id} onClick={() => onPick(id)}><code>{id}</code></button>)}</div>
    </>}
    {canonical && draft.trim() !== canonical && <p role="status" className="muted text-label">
      {t("pws.discovery.corrected")} <code>{canonical}</code></p>}
    {canonical && onUpdateProvider && <button type="button" className="btn btn-ghost btn-sm"
      disabled={saving || canonical === item.defaultModel} onClick={() => { void setDefault(); }}>{t("pws.discovery.setDefault")}</button>}
  </div>;
}
