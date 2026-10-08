import { useCallback, useEffect, useMemo, useState } from "react";
import { readJsonOrThrow } from "../fetch-json";
import { Notice, Select } from "../ui";

type AgentKey = "orchestrator" | "recon" | "classifier" | "exploit" | "report";
type AgentModel = { provider: string; model: string };
type AgentMap = Record<AgentKey, AgentModel>;
type AvailableModel = { namespaced: string; provider: string; model: string };

const AGENTS: readonly { key: AgentKey; label: string }[] = [
  { key: "orchestrator", label: "Orkestratör" },
  { key: "recon", label: "Keşif (recon)" },
  { key: "classifier", label: "Sınıflandırıcı" },
  { key: "exploit", label: "Exploit" },
  { key: "report", label: "Rapor" },
];

type Payload = {
  agents?: Partial<Record<AgentKey, AgentModel>>;
  available?: AvailableModel[];
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
  const [agents, setAgents] = useState<AgentMap>(emptyMap);
  const [available, setAvailable] = useState<AvailableModel[]>([]);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${apiBase}/api/operation-models`);
      const data = await readJsonOrThrow<Payload>(res);
      const next = emptyMap();
      for (const agent of AGENTS) {
        const row = data?.agents?.[agent.key];
        if (row) next[agent.key] = { provider: row.provider ?? "", model: row.model ?? "" };
      }
      setAgents(next);
      setAvailable(Array.isArray(data?.available) ? data.available : []);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [apiBase]);

  useEffect(() => { void load(); }, [load]);

  const byNamespaced = useMemo(() => {
    const map = new Map<string, AgentModel>();
    for (const row of available) map.set(row.namespaced, { provider: row.provider, model: row.model });
    return map;
  }, [available]);

  const options = useMemo(
    () => [
      { value: "", label: "(orkestratörden devral)" },
      ...available.map(row => ({ value: row.namespaced, label: row.namespaced })),
    ],
    [available],
  );

  const setAgent = useCallback((key: AgentKey, namespaced: string) => {
    const picked = namespaced ? byNamespaced.get(namespaced) : undefined;
    setAgents(prev => ({
      ...prev,
      [key]: picked ? { provider: picked.provider, model: picked.model } : { provider: "", model: "" },
    }));
  }, [byNamespaced]);

  const save = useCallback(async () => {
    setBusy(true); setStatus(""); setError("");
    try {
      const res = await fetch(`${apiBase}/api/operation-models`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agents }),
      });
      await readJsonOrThrow(res);
      setStatus("Kaydedildi");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [apiBase, agents]);

  return (
    <div className="page">
      <div className="page-head">
        <h2>Operasyon</h2>
      </div>
      <p className="page-sub">
        Operasyonda çalışacak AI modellerini buradan ayarla. Boş bırakılan ajanlar orkestratörün
        modelini devralır. Kaydedilen seçim OpenCodex'te saklanır; ajanlar da aynı ayarı
        <code> ocx operation </code> veya <code>GET/PUT /api/operation-models</code> ile okuyup yazabilir.
      </p>

      {error ? <Notice tone="err">{error}</Notice> : null}
      {status ? <Notice tone="ok">{status}</Notice> : null}

      <div style={{ display: "grid", gap: 12, maxWidth: 640, marginTop: 16 }}>
        {AGENTS.map(agent => (
          <div key={agent.key} style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span style={{ minWidth: 160 }}>{agent.label}</span>
            <Select
              value={namespacedOf(agents[agent.key])}
              options={agent.key === "orchestrator" ? options.slice(1) : options}
              onChange={value => setAgent(agent.key, value)}
              style={{ minWidth: 340 }}
              align="left"
            />
          </div>
        ))}
      </div>

      <div style={{ marginTop: 20 }}>
        <button type="button" onClick={() => void save()} disabled={busy}>
          {busy ? "Kaydediliyor…" : "Kaydet"}
        </button>
      </div>
    </div>
  );
}
