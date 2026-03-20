import { createClient } from "redis";
import blessed from "blessed";
import { format } from "node:util";

// Redis keys (mirrors @chat/shared constants)
const serversClientCountKey = "servers:clients";
const serversChatRoomsCountKey = "servers:chats";
const serversHeartbeatKey = "servers:heartbeat";
const serversSocketWritesPerSecondKey = "servers:mps";
const serversEventLoopTimeoutKey = "servers:event-loop";
const redisServerKeyFactory = (id: string) => `server:${id}`;

const POLL_INTERVAL_MS = 1000;
const MAX_SERVER_LINES = 20;
const UUID_DISPLAY_LEN = 8;

const trim = (id: string) => id.slice(0, UUID_DISPLAY_LEN);
const timestamp = () =>
  new Date().toLocaleTimeString("en-US", { hour12: false });
const fmt = (n: number, decimals = 2) => n.toFixed(decimals);
const fmtAge = (ms: number) => {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m${Math.floor((ms % 60_000) / 1000)}s`;
};
const fmtDuration = (startedAt: number) => {
  const s = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return [h, m, sec].map((v) => v.toString().padStart(2, "0")).join(":");
};

interface ServerMetrics {
  id: string;
  url: string;
  clients: number;
  chatRooms: number;
  mps: number;
  eventLoopTimeout: number;
  heartbeatAgeMs: number;
}

interface Snapshot {
  servers: ServerMetrics[];
  totalClients: number;
  totalChatRooms: number;
  totalMps: number;
  pollCount: number;
  lastPolledAt: string;
  redisStatus: "connected" | "connecting" | "error";
}

async function pollRedis(
  client: ReturnType<typeof createClient>,
): Promise<ServerMetrics[]> {
  const now = Date.now();

  const [clients, chatRooms, heartbeats, mps, eventLoop] = await Promise.all([
    client.zRangeWithScores(serversClientCountKey, 0, -1),
    client.zRangeWithScores(serversChatRoomsCountKey, 0, -1),
    client.zRangeWithScores(serversHeartbeatKey, 0, -1),
    client.zRangeWithScores(serversSocketWritesPerSecondKey, 0, -1),
    client.zRangeWithScores(serversEventLoopTimeoutKey, 0, -1),
  ]);

  const serverIds = new Set([
    ...clients.map((e) => e.value),
    ...heartbeats.map((e) => e.value),
    ...mps.map((e) => e.value),
  ]);

  const servers: ServerMetrics[] = [];
  for (const id of serverIds) {
    const url =
      (await client.hGet(redisServerKeyFactory(id), "url")) ?? "unknown";

    servers.push({
      id,
      url,
      clients: clients.find((e) => e.value === id)?.score ?? 0,
      chatRooms: chatRooms.find((e) => e.value === id)?.score ?? 0,
      mps: mps.find((e) => e.value === id)?.score ?? 0,
      eventLoopTimeout: eventLoop.find((e) => e.value === id)?.score ?? 0,
      heartbeatAgeMs:
        now - (heartbeats.find((e) => e.value === id)?.score ?? 0),
    });
  }

  return servers;
}

function heartbeatColor(ageMs: number): string {
  if (ageMs < 2000) return "{green-fg}";
  if (ageMs < 5000) return "{yellow-fg}";
  return "{red-fg}";
}

function formatServerBlock(s: ServerMetrics): string {
  const hbColor = heartbeatColor(s.heartbeatAgeMs);
  const hbReset = "{/}";
  return [
    `  id           ${trim(s.id)}`,
    `  url          ${s.url}`,
    `  clients      ${s.clients}`,
    `  chat rooms   ${s.chatRooms}`,
    `  mps          ${fmt(s.mps)}`,
    `  event loop   ${fmt(s.eventLoopTimeout)}ms`,
    `  heartbeat    ${hbColor}${fmtAge(s.heartbeatAgeMs)} ago${hbReset}`,
  ].join("\n");
}

class RedisMonitorUi {
  private readonly startedAt = Date.now();
  private readonly originalConsole = {
    error: console.error.bind(console),
    log: console.log.bind(console),
    warn: console.warn.bind(console),
  };

  private screen: blessed.Widgets.Screen;
  private headerBox: blessed.Widgets.BoxElement;
  private metricsBox: blessed.Widgets.BoxElement;
  private serversBox: blessed.Widgets.BoxElement;
  private logBox: blessed.Widgets.Log;

  private snapshot: Snapshot = {
    servers: [],
    totalClients: 0,
    totalChatRooms: 0,
    totalMps: 0,
    pollCount: 0,
    lastPolledAt: "-",
    redisStatus: "connecting",
  };

  constructor() {
    this.screen = blessed.screen({
      smartCSR: true,
      title: "redis-monitor",
      dockBorders: true,
      fullUnicode: false,
    });

    this.headerBox = blessed.box({
      parent: this.screen,
      top: 0,
      left: 0,
      width: "100%",
      height: 4,
      tags: true,
      border: "line",
      style: { border: { fg: "cyan" } },
    });

    this.metricsBox = blessed.box({
      parent: this.screen,
      top: 4,
      left: 0,
      width: "50%",
      height: 11,
      tags: true,
      border: "line",
      label: " totals ",
      style: { border: { fg: "green" } },
    });

    this.serversBox = blessed.box({
      parent: this.screen,
      top: 4,
      left: "50%",
      width: "50%",
      height: "100%-4",
      tags: true,
      border: "line",
      label: " servers ",
      scrollable: true,
      alwaysScroll: true,
      mouse: true,
      keys: true,
      vi: true,
      scrollbar: { ch: " " },
      style: { border: { fg: "yellow" } },
    });

    this.logBox = blessed.log({
      parent: this.screen,
      top: 15,
      left: 0,
      width: "50%",
      height: "100%-15",
      tags: false,
      border: "line",
      label: " events ",
      scrollable: true,
      alwaysScroll: true,
      mouse: true,
      keys: true,
      vi: true,
      scrollbar: { ch: " " },
      style: { border: { fg: "magenta" } },
    });

    this.screen.key(["C-c", "q", "escape"], () => {
      process.kill(process.pid, "SIGINT");
    });
    this.screen.key(["pageup"], () => this.logBox.scroll(-5));
    this.screen.key(["pagedown"], () => this.logBox.scroll(5));
    this.screen.key(["S-pageup"], () => this.serversBox.scroll(-5));
    this.screen.key(["S-pagedown"], () => this.serversBox.scroll(5));

    this.patchConsole();
    this.render();
  }

  setSnapshot(snapshot: Snapshot) {
    this.snapshot = snapshot;
    this.render();
  }

  destroy() {
    this.restoreConsole();
    try {
      this.screen.destroy();
    } catch {
      // ignore
    }
  }

  private patchConsole() {
    console.log = (...args: unknown[]) => this.writeLog("log", args);
    console.warn = (...args: unknown[]) => this.writeLog("warn", args);
    console.error = (...args: unknown[]) => this.writeLog("error", args);
  }

  private restoreConsole() {
    console.log = this.originalConsole.log;
    console.warn = this.originalConsole.warn;
    console.error = this.originalConsole.error;
  }

  private writeLog(level: "log" | "warn" | "error", args: unknown[]) {
    const line = `[${timestamp()}] ${level.toUpperCase()} ${format(...args)}`;
    this.logBox.log(line);
    this.render();
  }

  private render() {
    const { snapshot } = this;
    const statusColor =
      snapshot.redisStatus === "connected"
        ? "{green-fg}"
        : snapshot.redisStatus === "connecting"
          ? "{yellow-fg}"
          : "{red-fg}";

    this.headerBox.setContent(
      [
        `{bold}redis-monitor{/bold}  ${statusColor}${snapshot.redisStatus}{/}`,
        `uptime ${fmtDuration(this.startedAt)}  polls ${snapshot.pollCount}  last ${snapshot.lastPolledAt}`,
        `watching: ${[serversClientCountKey, serversChatRoomsCountKey, serversHeartbeatKey, serversSocketWritesPerSecondKey, serversEventLoopTimeoutKey].join("  ")}`,
      ].join("\n"),
    );

    this.metricsBox.setContent(
      [
        `total servers     ${snapshot.servers.length}`,
        `total clients     ${snapshot.totalClients}`,
        `total chat rooms  ${snapshot.totalChatRooms}`,
        `total mps         ${fmt(snapshot.totalMps)}`,
        ``,
        `healthy           ${snapshot.servers.filter((s) => s.heartbeatAgeMs < 2000).length}`,
        `degraded          ${snapshot.servers.filter((s) => s.heartbeatAgeMs >= 2000 && s.heartbeatAgeMs < 5000).length}`,
        `dead              ${snapshot.servers.filter((s) => s.heartbeatAgeMs >= 5000).length}`,
      ].join("\n"),
    );

    const serverBlocks = snapshot.servers
      .sort((a, b) => a.id.localeCompare(b.id))
      .slice(0, MAX_SERVER_LINES)
      .map(formatServerBlock);

    this.serversBox.setContent(
      serverBlocks.length > 0
        ? serverBlocks.join("\n{gray-fg}──────────────────────────{/}\n")
        : "{gray-fg}no servers in redis{/}",
    );

    this.screen.render();
  }
}

async function main() {
  const client = createClient();
  const ui = new RedisMonitorUi();

  let pollCount = 0;

  const poll = async () => {
    try {
      const servers = await pollRedis(client);
      pollCount++;
      ui.setSnapshot({
        servers,
        totalClients: servers.reduce((s, sv) => s + sv.clients, 0),
        totalChatRooms: servers.reduce((s, sv) => s + sv.chatRooms, 0),
        totalMps: servers.reduce((s, sv) => s + sv.mps, 0),
        pollCount,
        lastPolledAt: timestamp(),
        redisStatus: "connected",
      });
    } catch (err) {
      console.error("poll failed:", err);
      ui.setSnapshot({
        servers: [],
        totalClients: 0,
        totalChatRooms: 0,
        totalMps: 0,
        pollCount,
        lastPolledAt: timestamp(),
        redisStatus: "error",
      });
    }
  };

  const shutdown = async () => {
    ui.destroy();
    await client.quit();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  try {
    await client.connect();
    console.log("redis connected");
  } catch (err) {
    console.error("redis connect failed:", err);
  }

  await poll();
  setInterval(poll, POLL_INTERVAL_MS);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
