/// 100% vibe coded nonsense, idk what happens in here one bit
import blessed from "blessed";
import type { ServerState } from "@chat/shared";
import { format } from "node:util";

interface RuntimeInfo {
  port: number;
  serviceName: string;
}

interface RedistributionSnapshot {
  amount: number;
  serverId: string;
  timestamp: string;
}

interface ChildServerSnapshot {
  clients: number;
  isKilled: boolean;
  mps: number;
  pid?: number;
  serverId: string;
  state: ServerState;
}

export interface TerminalUiSnapshot {
  blacklistedServers: Array<[string, number]>;
  childServers: ChildServerSnapshot[];
  currentRequests: number;
  lastProvisionedServer: string | null;
  lastRedistribution: RedistributionSnapshot | null;
  lastRemovedServer: string | null;
  optimalDistribution: number;
  provisionCount: number;
  pps: number;
  serverMps: Array<[string, number]>;
  serverLoads: Array<[string, number]>;
  status: string;
  timedOutServers: string[];
  totalClients: number;
  totalServers: number;
}

const MAX_SERVER_LINES = 10;
const MAX_RENDERED_ARRAY_ITEMS = 10;
const LIST_UUID_LENGTH = 5;

const timestamp = () =>
  new Date().toLocaleTimeString("en-US", {
    hour12: false,
  });

const formatNumber = (value: number) => value.toFixed(2);
const formatNumberArray = (values: number[]) =>
  values
    .slice(values.length - 10, values.length)
    .reverse()
    .map((value) => Number(formatNumber(value)));
const formatServerJson = (value: unknown) =>
  JSON.stringify(value, null, 2)
    .replaceAll("[\n      ", "[")
    .replaceAll(",\n      ", ", ")
    .replaceAll("\n    ]", "]");

const formatDuration = (startedAt: number) => {
  const elapsedSeconds = Math.max(
    0,
    Math.floor((Date.now() - startedAt) / 1000),
  );
  const hours = Math.floor(elapsedSeconds / 3600);
  const minutes = Math.floor((elapsedSeconds % 3600) / 60);
  const seconds = elapsedSeconds % 60;

  return [hours, minutes, seconds]
    .map((value) => value.toString().padStart(2, "0"))
    .join(":");
};

const truncateListUuid = (value: string) => value.slice(0, LIST_UUID_LENGTH);
class LoadBalancerTerminalUi {
  private enabled: boolean;
  private readonly originalConsole = {
    error: console.error.bind(console),
    log: console.log.bind(console),
    warn: console.warn.bind(console),
  };
  private readonly runtimeInfo: RuntimeInfo = {
    port: 0,
    serviceName: "load-balancer",
  };
  private readonly startedAt = Date.now();
  private snapshot: TerminalUiSnapshot = {
    blacklistedServers: [],
    childServers: [],
    currentRequests: 0,
    lastProvisionedServer: null,
    lastRedistribution: null,
    lastRemovedServer: null,
    optimalDistribution: 0,
    provisionCount: 0,
    pps: 0,
    serverMps: [],
    serverLoads: [],
    status: "starting",
    timedOutServers: [],
    totalClients: 0,
    totalServers: 0,
  };
  private headerBox?: blessed.Widgets.BoxElement;
  private logBox?: blessed.Widgets.Log;
  private metricsBox?: blessed.Widgets.BoxElement;
  private renderTimer?: NodeJS.Timeout;
  private screen?: blessed.Widgets.Screen;
  private serverBox?: blessed.Widgets.BoxElement;

  constructor() {
    this.enabled = Boolean(process.stdout.isTTY && process.stdin.isTTY);

    if (!this.enabled) {
      return;
    }

    try {
      this.screen = blessed.screen({
        smartCSR: true,
        title: "load-balancer",
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
        style: {
          border: {
            fg: "cyan",
          },
        },
      });

      this.metricsBox = blessed.box({
        parent: this.screen,
        top: 4,
        left: 0,
        width: "50%",
        height: 13,
        tags: true,
        border: "line",
        label: " runtime ",
        style: {
          border: {
            fg: "green",
          },
        },
      });

      this.serverBox = blessed.box({
        parent: this.screen,
        top: 4,
        left: "50%",
        width: "50%",
        height: "100%-4",
        tags: false,
        border: "line",
        label: " servers ",
        scrollable: true,
        alwaysScroll: true,
        mouse: true,
        keys: true,
        vi: true,
        scrollbar: {
          ch: " ",
        },
        style: {
          border: {
            fg: "yellow",
          },
        },
      });

      this.logBox = blessed.log({
        parent: this.screen,
        top: 17,
        left: 0,
        width: "50%",
        height: "100%-17",
        tags: false,
        border: "line",
        label: " stdout ",
        scrollable: true,
        alwaysScroll: true,
        mouse: true,
        keys: true,
        vi: true,
        scrollbar: {
          ch: " ",
        },
        style: {
          border: {
            fg: "magenta",
          },
        },
      });

      this.screen.key(["C-c"], () => {
        process.kill(process.pid, "SIGINT");
      });
      this.screen.key(["q"], () => {
        process.kill(process.pid, "SIGINT");
      });
      this.screen.key(["escape"], () => {
        process.kill(process.pid, "SIGINT");
      });
      this.screen.key(["pageup"], () => this.logBox?.scroll(-5));
      this.screen.key(["pagedown"], () => this.logBox?.scroll(5));
      this.screen.key(["S-pageup"], () => this.serverBox?.scroll(-5));
      this.screen.key(["S-pagedown"], () => this.serverBox?.scroll(5));

      this.patchConsole();
      this.render();
      this.renderTimer = setInterval(() => this.render(), 1000);
      this.renderTimer.unref();
    } catch (error) {
      this.disable(error);
    }
  }

  setRuntimeInfo(info: RuntimeInfo) {
    this.runtimeInfo.port = info.port;
    this.runtimeInfo.serviceName = info.serviceName;
    this.render();
  }

  setSnapshot(snapshot: TerminalUiSnapshot) {
    this.snapshot = snapshot;
    this.render();
  }

  destroy() {
    this.restoreConsole();

    if (this.renderTimer) {
      clearInterval(this.renderTimer);
      this.renderTimer = undefined;
    }

    try {
      this.screen?.destroy();
    } catch {
      // Ignore terminal cleanup failures during shutdown.
    }
  }

  private patchConsole() {
    console.log = (...args: unknown[]) => {
      this.writeLog("log", args);
    };
    console.warn = (...args: unknown[]) => {
      this.writeLog("warn", args);
    };
    console.error = (...args: unknown[]) => {
      this.writeLog("error", args);
    };
  }

  private restoreConsole() {
    console.log = this.originalConsole.log;
    console.warn = this.originalConsole.warn;
    console.error = this.originalConsole.error;
  }

  private writeLog(level: "log" | "warn" | "error", args: unknown[]) {
    const line = `[${timestamp()}] ${level.toUpperCase()} ${format(...args)}`;

    if (!this.enabled) {
      this.originalConsole[level](line);
      return;
    }

    try {
      this.logBox?.log(line);
      this.render();
    } catch (error) {
      this.originalConsole[level](line);
      this.disable(error);
    }
  }

  private render() {
    if (
      !this.enabled ||
      !this.screen ||
      !this.headerBox ||
      !this.metricsBox ||
      !this.serverBox
    ) {
      return;
    }

    try {
      const redistributionLines =
        this.snapshot.lastRedistribution === null
          ? ["redistribute     -"]
          : [
              `redistribute     ${this.snapshot.lastRedistribution.amount} from ${truncateListUuid(this.snapshot.lastRedistribution.serverId)}`,
              `                 at ${this.snapshot.lastRedistribution.timestamp}`,
            ];
      const timedOutLines =
        this.snapshot.timedOutServers.length === 0
          ? ["timed out        -"]
          : [
              "timed out",
              ...this.snapshot.timedOutServers.map(
                (serverId) => `                 ${truncateListUuid(serverId)}`,
              ),
            ];

      this.headerBox.setContent(
        [
          `{bold}${this.runtimeInfo.serviceName}{/bold}  {cyan-fg}${this.snapshot.status}{/cyan-fg}`,
          `port ${this.runtimeInfo.port || "-"}  uptime ${formatDuration(this.startedAt)}`,
          `last provisioned ${this.snapshot.lastProvisionedServer ?? "-"}  last removed ${this.snapshot.lastRemovedServer ?? "-"}`,
        ].join("\n"),
      );

      this.metricsBox.setContent(
        [
          `provision reqs    ${this.snapshot.provisionCount}`,
          `pps               ${this.snapshot.pps}`,
          `current reqs      ${this.snapshot.currentRequests}`,
          `total servers     ${this.snapshot.totalServers}`,
          `total clients     ${this.snapshot.totalClients}`,
          `optimal load      ${this.snapshot.optimalDistribution.toFixed(2)}`,
          `blacklisted       ${this.snapshot.blacklistedServers.length}`,
          ...redistributionLines,
          ...timedOutLines,
        ].join("\n"),
      );

      const serverLines = [...this.snapshot.childServers]
        .sort((left, right) => left.serverId.localeCompare(right.serverId))
        .slice(0, MAX_SERVER_LINES)
        .map(({ isKilled, mps, serverId, state }) => {
          const blacklistAge = this.snapshot.blacklistedServers.find(
            ([blacklistedServerId]) => blacklistedServerId === serverId,
          )?.[1];
          return formatServerJson({
            id: truncateListUuid(serverId),
            status:
              blacklistAge !== undefined
                ? "blacklisted"
                : isKilled
                  ? "killed"
                  : "healthy",
            mps: Number(formatNumber(mps)),
            state: {
              clients: formatNumberArray(state.clients),
              socketWrites: formatNumberArray(state.socketWrites),
              timeouts: formatNumberArray(state.timeouts),
            },
          });
        });

      this.serverBox.setContent(
        serverLines.length > 0
          ? serverLines.join("\n\n")
          : "No child servers tracked.",
      );

      this.screen.render();
    } catch (error) {
      this.disable(error);
    }
  }

  private disable(error: unknown) {
    if (!this.enabled) {
      return;
    }

    this.enabled = false;
    this.restoreConsole();

    if (this.renderTimer) {
      clearInterval(this.renderTimer);
      this.renderTimer = undefined;
    }

    try {
      this.screen?.destroy();
    } catch {
      // Ignore terminal cleanup failures when disabling the UI.
    }

    this.screen = undefined;
    this.headerBox = undefined;
    this.metricsBox = undefined;
    this.serverBox = undefined;
    this.logBox = undefined;

    this.originalConsole.warn("terminal UI disabled:", error);
  }
}

export const terminalUi = new LoadBalancerTerminalUi();
