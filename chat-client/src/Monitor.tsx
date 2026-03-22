import { useEffect, useRef, useState } from "react";

interface ServerHistory {
  clients: number[];
  chatRooms: number[];
  socketWrites: number[];
  timeouts: number[];
}

interface ServerMetrics {
  id: string;
  url: string | null;
  clients: number;
  chatRooms: number;
  mps: number;
  eventLoopTimeout: number;
  heartbeatAgeMs: number;
  history: ServerHistory;
}

interface RedisStats {
  ts: number;
  servers: ServerMetrics[];
  totals: { clients: number; chatRooms: number; mps: number };
  chatRooms: { messageCounts: { value: string; score: number }[] };
}

const POLL_MS = 1000;

const fmt = (n: number, d = 2) => n.toFixed(d);
const fmtAge = (ms: number) => {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m${Math.floor((ms % 60_000) / 1000)}s`;
};
const shortId = (id: string) => id.slice(0, 8);
const heartbeatClass = (ms: number) =>
  ms < 2000 ? "hb-healthy" : ms < 5000 ? "hb-degraded" : "hb-dead";

// SVG sparkline — no dependencies
function Sparkline({
  data,
  color = "#3fb950",
  width = 200,
  height = 50,
}: {
  data: number[];
  color?: string;
  width?: number;
  height?: number;
}) {
  if (data.length < 2)
    return <svg width={width} height={height} className="sparkline" />;

  const max = Math.max(...data);
  const min = 0;
  const range = max - min || 1;
  const padX = 1;
  const padY = 3;

  const toX = (i: number) =>
    padX + (i / (data.length - 1)) * (width - padX * 2);
  const toY = (v: number) =>
    padY + (1 - (v - min) / range) * (height - padY * 2);

  const linePoints = data
    .map((v, i) => `${toX(i).toFixed(1)},${toY(v).toFixed(1)}`)
    .join(" ");

  // area: line points + bottom-right + bottom-left
  const areaPoints = [
    ...data.map((v, i) => `${toX(i).toFixed(1)},${toY(v).toFixed(1)}`),
    `${toX(data.length - 1).toFixed(1)},${height}`,
    `${toX(0).toFixed(1)},${height}`,
  ].join(" ");

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="sparkline"
    >
      <defs>
        <linearGradient
          id={`grad-${color.replace("#", "")}`}
          x1="0"
          y1="0"
          x2="0"
          y2="1"
        >
          <stop offset="0%" stopColor={color} stopOpacity="0.3" />
          <stop offset="100%" stopColor={color} stopOpacity="0.03" />
        </linearGradient>
      </defs>
      <polygon
        points={areaPoints}
        fill={`url(#grad-${color.replace("#", "")})`}
      />
      <polyline
        points={linePoints}
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

function ServerCard({ s }: { s: ServerMetrics }) {
  const hbClass = heartbeatClass(s.heartbeatAgeMs);
  return (
    <div className={`server-card ${hbClass}`}>
      <div className="server-card-header">
        <span className="server-card-id">{shortId(s.id)}</span>
        <span className="server-card-url">{s.url ?? "—"}</span>
        <span className={`server-card-hb hb-cell ${hbClass}`}>
          {fmtAge(s.heartbeatAgeMs)} ago
        </span>
      </div>
      <div className="server-graphs">
        <Graph
          label="clients"
          current={s.clients}
          data={s.history?.clients ?? []}
          color="#7d9fc5"
        />
        <Graph
          label="swps"
          current={s.mps}
          data={s.history?.socketWrites ?? []}
          color="#3fb950"
          fmt={(v) => fmt(v)}
        />
        <Graph
          label="event loop"
          current={s.eventLoopTimeout}
          data={s.history?.timeouts ?? []}
          color="#d29922"
          fmt={(v) => `${fmt(v)}ms`}
        />
      </div>
    </div>
  );
}

function Graph({
  label,
  current,
  data,
  color,
  fmt: fmtVal = (v) => String(Math.round(v)),
}: {
  label: string;
  current: number;
  data: number[];
  color: string;
  fmt?: (v: number) => string;
}) {
  const max = data.length ? Math.max(...data) : 0;
  return (
    <div className="graph">
      <div className="graph-meta">
        <span className="graph-label">{label}</span>
        <span className="graph-label">
          avg: {(data.reduce((a, b) => a + b) / data.length).toFixed(3)}
        </span>
        <span className="graph-current" style={{ color }}>
          {fmtVal(current)}
        </span>
        <span className="graph-max">max {fmtVal(max)}</span>
      </div>
      <Sparkline data={data} color={color} width={160} height={36} />
    </div>
  );
}

function Stat({
  label,
  value,
  accent,
}: {
  label: string;
  value: string | number;
  accent?: "green" | "yellow" | "red";
}) {
  return (
    <div className="stat-card">
      <span className="stat-label">{label}</span>
      <span className={`stat-value${accent ? ` stat-value--${accent}` : ""}`}>
        {value}
      </span>
    </div>
  );
}

export function Monitor() {
  const [stats, setStats] = useState<RedisStats | null>(null);
  const [status, setStatus] = useState<"ok" | "error" | "loading">("loading");
  const [lastUpdated, setLastUpdated] = useState("-");
  const [pollCount, setPollCount] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const poll = async () => {
    try {
      const res = await fetch("/api/redis-stats");
      if (!res.ok) throw new Error(`${res.status}`);
      const data: RedisStats = await res.json();
      setStats(data);
      setStatus("ok");
      setLastUpdated(new Date().toLocaleTimeString("en-US", { hour12: false }));
      setPollCount((c) => c + 1);
    } catch {
      setStatus("error");
    }
  };

  useEffect(() => {
    poll();
    timerRef.current = setInterval(poll, POLL_MS);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  const sortedRooms = stats
    ? [...stats.chatRooms.messageCounts].sort((a, b) => b.score - a.score)
    : [];

  return (
    <div className="monitor">
      <div className="monitor-header">
        <span className="monitor-title">redis monitor</span>
        <span className={`monitor-status monitor-status--${status}`}>
          {status}
        </span>
        <span className="monitor-meta">
          polls {pollCount} · {lastUpdated}
        </span>
      </div>

      {stats && (
        <div className="monitor-body">
          <div className="monitor-main">
            <div className="monitor-totals">
              <Stat label="servers" value={stats.servers.length} />
              <Stat label="clients" value={stats.totals.clients} />
              <Stat label="total mps" value={fmt(stats.totals.mps)} />
              <Stat
                label="healthy"
                value={
                  stats.servers.filter((s) => s.heartbeatAgeMs < 2000).length
                }
                accent="green"
              />
              <Stat
                label="degraded"
                value={
                  stats.servers.filter(
                    (s) => s.heartbeatAgeMs >= 2000 && s.heartbeatAgeMs < 5000,
                  ).length
                }
                accent="yellow"
              />
              <Stat
                label="dead"
                value={
                  stats.servers.filter((s) => s.heartbeatAgeMs >= 5000).length
                }
                accent="red"
              />
            </div>

            <div className="server-cards">
              {stats.servers.length === 0 && (
                <p className="monitor-empty">no servers in redis</p>
              )}
              {stats.servers.map((s) => (
                <ServerCard key={s.id} s={s} />
              ))}
            </div>
          </div>

          <div className="monitor-sidebar">
            <div className="sidebar-title">chat rooms</div>
            {sortedRooms.length === 0 && (
              <p className="monitor-empty">no rooms</p>
            )}
            {sortedRooms.map((room) => (
              <div key={room.value} className="room-row">
                <span className="room-name">{room.value}</span>
                <span className="room-msgs">{room.score}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {status === "error" && !stats && (
        <p className="error">failed to reach /api/redis-stats</p>
      )}
    </div>
  );
}
