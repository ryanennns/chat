import { useEffect, useRef, useState } from "react";
import { NumericList, type Server, type ServerState } from "@chat/shared";

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
}

function trimStats(raw: {
  socketServers: { server: Server; state: Record<string, unknown> }[];
  chatRooms: Record<string, Record<string, unknown>>;
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
}: {
  label: string;
  data: NumericList;
  color: string;
}) {
  const t10 = data.lastN(10).trendScore();
  const t50 = data.lastN(50).trendScore();
  const tAll = data.trendScore();

  const Trend = ({ score, label }: { score: number; label: string }) => (
    <span className="graph-trend" style={{ color: trendColor(score) }}>
      {label}:{score >= 0 ? "+" : ""}{score.toFixed(2)}
    </span>
  );

  return (
    <div className="graph">
      <div className="graph-meta">
        <span className="graph-label">{label}</span>
        <span className="graph-current" style={{ color }}>
          {data.last() ?? 0}
        </span>
        <Trend score={t10} label="10" />
        <Trend score={t50} label="50" />
        <Trend score={tAll} label={`${data.length}`} />
      </div>
      <Sparkline data={data} color={color} />
    </div>
  );
}

function ServerCard({ s }: { s: SocketServer }) {
  const swpsDeltas = s.state.socketWrites.deltas();
  return (
    <div className="server-card">
      <div className="server-card-header">
        <span className="server-card-id">{s.server.id.slice(0, 8)}</span>
        <span className="server-card-url">{s.server.url ?? "—"}</span>
      </div>
      <div className="server-graphs">
        <Graph label="clients" data={s.state.clients} color="#7d9fc5" />
        <Graph label="swps" data={swpsDeltas} color="#3fb950" />
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
      const data = await res.json();
      setStats(trimStats(data));
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
        <div className="monitor-body">
          <div className="server-cards">
            {stats.socketServers.length === 0 && (
              <p className="monitor-empty">no servers</p>
            )}
            {stats.socketServers.map((s) => (
              <ServerCard key={s.server.id} s={s} />
            ))}
          </div>
          <div className="server-cards">
            {sortedRooms.length === 0 && (
              <p className="monitor-empty">no rooms</p>
            )}
            {sortedRooms.map(([id, room]) => (
              <ChatRoomCard key={id} id={id} room={room} />
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
