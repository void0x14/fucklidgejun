import { useEffect, useMemo, useState } from "react";
import { readJsonOrThrow } from "../fetch-json";
import { createBoundedFetch } from "../bounded-fetch";
import { useT, type TKey } from "../i18n/shared";
import { Notice, Select } from "../ui";

type AgentKey = "orchestrator" | "recon" | "classifier" | "exploit" | "report";
type AgentModel = { provider: string; model: string };
type AgentMap = Record<AgentKey, AgentModel>;
type AvailableModel = { namespaced: string; provider: string; model: string };

const AGENTS: readonly { key: AgentKey; label: TKey }[] = [
  { key: "orchestrator", label: "operation.orchestrator" },
  { key: "recon", label: "operation.recon" },
  { key: "classifier", label: "operation.classifier" },
  { key: "exploit", label: "operation.exploit" },
  { key: "report", label: "operation.report" },
];

type Payload = {
  agents: AgentMap;
  available: AvailableModel[];
};

function emptyMap(): AgentMap {
  return {
    orchestrator: { provider: "", model: "" },
    recon: { provider: "", model: "" },
    classifier: { provider: "", model: "" },
    exploit: { provider: "", model: "" },
    report: { provider: "", model: "" },
  };
}

function namespacedOf(row: AgentModel | undefined): string {
  if (!row || !row.provider || !row.model) return "";
  return `${row.provider}/${row.model}`;
}

export default function Operation({ apiBase }: { apiBase: string }) {
  const t = useT();
  const [agents, setAgents] = useState<AgentMap>(emptyMap);
  const [available, setAvailable] = useState<AvailableModel[]>([]);
  const [status, setStatus] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [loadedBase, setLoadedBase] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const ready = loadedBase === apiBase;

  useEffect(() => {
    let cancelled = false;
    const bounded = createBoundedFetch(20_000);
    void fetch(`${apiBase}/api/operation-models`, { signal: bounded.signal })
      .then(readJsonOrThrow<Payload>).then(data => {
        if (cancelled) return;
        if (!data?.agents || !Array.isArray(data.available)) throw new Error();
        const next = emptyMap();
        for (const agent of AGENTS) {
          const row = data.agents[agent.key];
          if (typeof row?.provider !== "string" || typeof row?.model !== "string") throw new Error();
          next[agent.key] = { provider: row.provider, model: row.model };
        }
        if (data.available.some(row => typeof row?.namespaced !== "string"
          || typeof row?.provider !== "string" || typeof row?.model !== "string")) throw new Error();
        setAgents(next);
        setAvailable(data.available);
        setError(null);
        setLoadedBase(apiBase);
      }).catch(e => { if (!cancelled) setError(e); }).finally(() => bounded.clear());
    return () => { cancelled = true; bounded.controller.abort(); bounded.clear(); };
  }, [apiBase, reload]);

  const byNamespaced = useMemo(() => {
    const map = new Map<string, AgentModel>();
    for (const row of available) map.set(row.namespaced, { provider: row.provider, model: row.model });
    return map;
  }, [available]);

  const options = useMemo(
    () => [
      { value: "", label: t("operation.inherit") },
      ...available.map(row => ({ value: row.namespaced, label: row.namespaced })),
    ],
    [available, t],
  );

  const setAgent = (key: AgentKey, namespaced: string) => {
    const picked = namespaced ? byNamespaced.get(namespaced) : undefined;
    if (namespaced && !picked) return;
    setAgents(prev => ({
      ...prev,
      [key]: picked ? { provider: picked.provider, model: picked.model } : { provider: "", model: "" },
    }));
    setStatus("");
  };

  const save = async () => {
    if (!ready || busy) return;
    const bounded = createBoundedFetch(20_000);
    setBusy(true); setStatus(""); setError(null);
    try {
      const res = await fetch(`${apiBase}/api/operation-models`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agents }),
        signal: bounded.signal,
      });
      const result = await readJsonOrThrow<{ saved?: boolean }>(res);
      if (result?.saved !== true) throw new Error();
      setStatus(t("operation.saved"));
    } catch (e) {
      setError(e);
    } finally {
      bounded.clear();
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <div className="page-head">
        <h2>{t("nav.operation")}</h2>
      </div>
      <p className="page-sub">
        {t("operation.hint")}
        <code> ocx operation </code> · <code>GET/PUT /api/operation-models</code>
      </p>

      {error ? <Notice tone="err">{error instanceof Error && error.message ? error.message : t(ready ? "operation.saveFailed" : "operation.loadFailed")}</Notice> : null}
      {!ready && !error ? <Notice tone="warn">{t("common.loading")}</Notice> : null}
      {error ? <button type="button" onClick={() => { setLoadedBase(null); setError(null); setStatus(""); setReload(n => n + 1); }}>{t("common.retry")}</button> : null}
      {status ? <Notice tone="ok">{status}</Notice> : null}

      <div style={{ display: "grid", gap: 12, maxWidth: 640, marginTop: 16 }}>
        {AGENTS.map(agent => {
          const value = namespacedOf(agents[agent.key]);
          const agentOptions = agent.key === "orchestrator"
            ? [{ value: "", label: t("operation.routingDefault") }, ...options.slice(1)]
            : [...options];
          if (value && !byNamespaced.has(value)) agentOptions.push({ value, label: `${value} (${t("operation.notListed")})` });
          return (
            <div key={agent.key} style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <label htmlFor={`operation-${agent.key}`} style={{ minWidth: 160 }}>{t(agent.label)}</label>
              <Select
                id={`operation-${agent.key}`}
                value={value}
                options={agentOptions}
                disabled={!ready || busy}
                onChange={value => setAgent(agent.key, value)}
                style={{ minWidth: 340 }}
                align="left"
              />
            </div>
          );
        })}
      </div>

      <div style={{ marginTop: 20 }}>
        <button type="button" onClick={() => void save()} disabled={!ready || busy}>
          {busy ? t("common.saving") : t("common.save")}
        </button>
      </div>
    </div>
  );
}
