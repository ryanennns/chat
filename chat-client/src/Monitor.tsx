import { useEffect, useRef, useState } from "react";
import {
  NumericList,
  type MemoryUsage,
  type Server,
  type ServerState,
} from "@chat/shared";

interface SocketServer {
  server: Server;
  state: ServerState;
}

interface ChatRoom {
  clients: NumericList;
  cumulativeMessages: NumericList;
  cumulativeSocketWrites: NumericList;
}

interface RedisStats {
  socketServers: SocketServer[];
  chatRooms: Record<string, ChatRoom>;
  blackList: Record<string, number>;
}

function trimStats(raw: {
  socketServers: { server: Server; state: Record<string, unknown> }[];
  chatRooms: Record<string, Record<string, unknown>>;
  blackList: Record<string, number>;
}): RedisStats {
  return {
    socketServers: raw.socketServers.map((s) => ({
      server: s.server,
      state: {
        clients: new NumericList(...(s.state.clients as number[])).lastN(100),
        socketWrites: new NumericList(
          ...(s.state.socketWrites as number[]),
        ).lastN(100),
        timeouts: new NumericList(...(s.state.timeouts as number[])).lastN(100),
        chatRooms: s.state.chatRooms as Record<string, number>,
        memory: (s.state.memory ?? {
          rss: 0,
          heapTotal: 0,
          heapUsed: 0,
          external: 0,
          arrayBuffers: 0,
        }) as MemoryUsage,
      },
    })),
    chatRooms: Object.fromEntries(
      Object.entries(raw.chatRooms).map(([id, r]) => [
        id,
        {
          clients: new NumericList(...(r.clients as number[])).lastN(100),
          cumulativeMessages: new NumericList(
            ...(r.cumulativeMessages as number[]),
          ).lastN(100),
          cumulativeSocketWrites: new NumericList(
            ...(r.cumulativeSocketWrites as number[]),
          ).lastN(100),
        },
      ]),
    ),
    blackList: raw.blackList ?? {},
  };
}

const POLL_MS = 1000;

function Sparkline({
  data,
  color = "#3fb950",
  width = 300,
  height = 40,
}: {
  data: NumericList;
  color?: string;
  width?: number;
  height?: number;
}) {
  if (data.length < 2)
    return <svg width="100%" height={height} className="sparkline" />;

  const max = data.max();
  const min = 0;
  const range = max - min || 1;
  const padX = 1;
  const padY = 3;

  const toX = (i: number) =>
    padX + (i / (data.length - 1)) * (width - padX * 2);
  const toY = (v: number) =>
    padY + (1 - (v - min) / range) * (height - padY * 2);

  const linePoints = [...data]
    .map((v, i) => `${toX(i).toFixed(1)},${toY(v).toFixed(1)}`)
    .join(" ");

  const areaPoints = [
    ...[...data].map((v, i) => `${toX(i).toFixed(1)},${toY(v).toFixed(1)}`),
    `${toX(data.length - 1).toFixed(1)},${height}`,
    `${toX(0).toFixed(1)},${height}`,
  ].join(" ");

  const gradId = `grad-${color.replace("#", "")}`;

  return (
    <svg
      width="100%"
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className="sparkline"
    >
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.3" />
          <stop offset="100%" stopColor={color} stopOpacity="0.03" />
        </linearGradient>
      </defs>
      <polygon points={areaPoints} fill={`url(#${gradId})`} />
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

function trendColor(score: number) {
  if (score > 0.1) return "#3fb950";
  if (score < -0.1) return "#f85149";
  return "#8b949e";
}

function Graph({
  label,
  data,
  color,
  trends = true,
  fmt = (v: number) => String(v),
}: {
  label: string;
  data: NumericList;
  color: string;
  trends?: boolean;
  fmt?: (v: number) => string;
}) {
  const t10 = trends ? data.lastN(10).trendScore() : 0;
  const t50 = trends ? data.lastN(50).trendScore() : 0;
  const tAll = trends ? data.trendScore() : 0;

  const Trend = ({ score, label }: { score: number; label: string }) => (
    <span className="graph-trend" style={{ color: trendColor(score) }}>
      {label}:{score >= 0 ? "+" : ""}
      {score.toFixed(2)}
    </span>
  );

  return (
    <div className="graph">
      <div className="graph-meta">
        <span className="graph-label">{label}</span>
        <span className="graph-current" style={{ color }}>
          {fmt(data.last() ?? 0)}
        </span>
        {trends && (
          <>
            <Trend score={t10} label="10" />
            <Trend score={t50} label="50" />
            <Trend score={tAll} label={`${data.length}`} />
          </>
        )}
      </div>
      <Sparkline data={data} color={color} />
    </div>
  );
}

function Summary({
  stats,
  clientsHistory,
}: {
  stats: RedisStats;
  clientsHistory: NumericList;
}) {
  const totalClients = stats.socketServers.reduce(
    (sum, s) => sum + (s.state.clients.last() ?? 0),
    0,
  );
  const totalSwps = stats.socketServers.reduce(
    (sum, s) => sum + (s.state.socketWrites.deltas().last() ?? 0),
    0,
  );
  const totalMsgs = Object.values(stats.chatRooms).reduce(
    (sum, r) => sum + (r.cumulativeMessages.deltas().last() ?? 0),
    0,
  );
  const avgEventLoop =
    stats.socketServers.length > 0
      ? stats.socketServers.reduce(
          (sum, s) => sum + (s.state.timeouts.last() ?? 0),
          0,
        ) / stats.socketServers.length
      : 0;

  const Stat = ({
    label,
    value,
    color,
  }: {
    label: string;
    value: string;
    color: string;
  }) => (
    <div className="summary-stat">
      <span className="summary-stat-value" style={{ color }}>
        {value}
      </span>
      <span className="summary-stat-label">{label}</span>
    </div>
  );

  return (
    <div className="monitor-summary">
      <Stat
        label="servers"
        value={String(stats.socketServers.length)}
        color="#8b949e"
      />
      <Stat
        label="rooms"
        value={String(Object.keys(stats.chatRooms).length)}
        color="#8b949e"
      />
      <div className="summary-divider" />
      <Stat label="clients" value={String(totalClients)} color="#7d9fc5" />
      <Stat label="swps" value={String(totalSwps)} color="#3fb950" />
      <Stat label="msg/s" value={String(totalMsgs)} color="#bc8cff" />
      <div className="summary-divider" />
      <Stat
        label="event loop"
        value={avgEventLoop.toFixed(2)}
        color="#d29922"
      />
      <div className="summary-divider" />
      <div className="summary-chart">
        <span className="summary-stat-label">clients over time</span>
        <Sparkline
          data={clientsHistory}
          color="#7d9fc5"
          width={200}
          height={36}
        />
      </div>
    </div>
  );
}

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)}mb`;

function ServerCard({ s, degraded }: { s: SocketServer; degraded?: boolean }) {
  const swpsDeltas = s.state.socketWrites.deltas();
  const mem = s.state.memory;
  return (
    <div className={`server-card${degraded ? " server-card--degraded" : ""}`}>
      <div className="server-card-header">
        <span className="server-card-id">{s.server.id.slice(0, 8)}</span>
        <span className="server-card-url">{s.server.url ?? "—"}</span>
        {degraded && <span className="server-card-degraded">degraded</span>}
      </div>
      <div className="server-graphs">
        <Graph label="clients" data={s.state.clients} color="#7d9fc5" />
        <Graph label="swps" data={swpsDeltas} color="#3fb950" />
        <Graph
          label="event loop"
          data={s.state.timeouts}
          color="#d29922"
          trends={false}
          fmt={(v) => v.toFixed(2)}
        />
      </div>
      <div className="server-memory">
        <span className="server-memory-item">
          heap <span style={{ color: "#bc8cff" }}>{mb(mem.heapUsed)}</span>
          <span style={{ color: "#8b949e" }}>/{mb(mem.heapTotal)}</span>
        </span>
        <span className="server-memory-item">
          rss <span style={{ color: "#d29922" }}>{mb(mem.rss)}</span>
        </span>
        <span className="server-memory-item">
          ext <span style={{ color: "#8b949e" }}>{mb(mem.external)}</span>
        </span>
      </div>
    </div>
  );
}

function ChatRoomCard({ id, room }: { id: string; room: ChatRoom }) {
  const msgDeltas = room.cumulativeMessages.deltas();
  const swpsDeltas = room.cumulativeSocketWrites.deltas();
  return (
    <div className="server-card">
      <div className="server-card-header">
        <span className="server-card-id">{id}</span>
        <span className="server-card-url">
          {room.clients.last() ?? 0} clients
        </span>
      </div>
      <div className="server-graphs">
        <Graph label="clients" data={room.clients} color="#7d9fc5" />
        <Graph label="msg/s" data={msgDeltas} color="#3fb950" />
        <Graph label="swps" data={swpsDeltas} color="#d29922" />
      </div>
    </div>
  );
}

function BlacklistSection({
  blackList,
}: {
  blackList: Record<string, number>;
}) {
  const entries = Object.entries(blackList);
  const now = Date.now();
  return (
    <div className="monitor-section">
      <span className="monitor-section-title">blacklist</span>
      {entries.length === 0 ? (
        <p className="monitor-empty">no blacklisted servers</p>
      ) : (
        <div className="blacklist-table">
          {entries.map(([id, since]) => (
            <div key={id} className="blacklist-row">
              <span className="blacklist-id">{id.slice(0, 8)}</span>
              <span className="blacklist-age">
                {Math.floor((now - since) / 1000)}s ago
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function Monitor() {
  const [stats, setStats] = useState<RedisStats | null>(null);
  const [status, setStatus] = useState<"ok" | "error" | "loading">("loading");
  const [lastUpdated, setLastUpdated] = useState("-");
  const [pollCount, setPollCount] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const knownServersRef = useRef<
    Map<string, { s: SocketServer; degraded: boolean }>
  >(new Map());
  const clientsHistoryRef = useRef<number[]>([]);

  const poll = async () => {
    try {
      const res = await fetch("/api/redis-stats");
      if (!res.ok) throw new Error(`${res.status}`);
      const data = await res.json();
      const trimmed = trimStats(data);

      const liveIds = new Set(trimmed.socketServers.map((s) => s.server.id));
      for (const [id, entry] of knownServersRef.current) {
        entry.degraded = !liveIds.has(id);
      }
      for (const s of trimmed.socketServers) {
        knownServersRef.current.set(s.server.id, { s, degraded: false });
      }

      const totalClients = trimmed.socketServers.reduce(
        (sum, s) => sum + (s.state.clients.last() ?? 0),
        0,
      );
      clientsHistoryRef.current.push(totalClients);
      if (clientsHistoryRef.current.length > 300)
        clientsHistoryRef.current.shift();

      setStats(trimmed);
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
    ? Object.entries(stats.chatRooms).sort(([a], [b]) =>
        a.localeCompare(b, undefined, { numeric: true }),
      )
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
        <Summary
          stats={stats}
          clientsHistory={new NumericList(...clientsHistoryRef.current)}
        />
      )}

      {stats && (
        <div className="monitor-body">
          <div className="monitor-section">
            <span className="monitor-section-title">servers</span>
            <div className="server-cards">
              {knownServersRef.current.size === 0 && (
                <p className="monitor-empty">no servers</p>
              )}
              {[...knownServersRef.current.values()].map(({ s, degraded }) => (
                <ServerCard key={s.server.id} s={s} degraded={degraded} />
              ))}
            </div>
          </div>
          <div className="monitor-section">
            <span className="monitor-section-title">rooms</span>
            <div className="server-cards">
              {sortedRooms.length === 0 && (
                <p className="monitor-empty">no rooms</p>
              )}
              {sortedRooms.map(([id, room]) => (
                <ChatRoomCard key={id} id={id} room={room} />
              ))}
            </div>
          </div>
          <BlacklistSection blackList={stats.blackList} />
        </div>
      )}

      {status === "error" && !stats && (
        <p className="error">failed to reach /api/redis-stats</p>
      )}
    </div>
  );
}
