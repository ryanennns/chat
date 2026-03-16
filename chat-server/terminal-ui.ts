import blessed from "blessed";
import { format } from "node:util";

interface ServerInfo {
  port: number;
  serverId: string;
  url: string;
}

interface BroadcastSnapshot {
  chatId: string;
  durationMs: number;
  recipients: number;
  timestamp: string;
}

interface RedistributeSnapshot {
  overBy: number;
  redistributeBy: number;
  timestamp: string;
}

export interface TerminalUiSnapshot {
  activeChats: number;
  broadcastCount: number;
  broadcastDurationTotalMs: number;
  chats: Array<[string, number]>;
  lastBroadcast: BroadcastSnapshot | null;
  lastLoopLagMs: number;
  lastPublishedChat: string | null;
  lastRedistribute: RedistributeSnapshot | null;
  messageCount: number;
  status: string;
  totalConnections: number;
}

const MAX_CHAT_LINES = 10;

const timestamp = () =>
  new Date().toLocaleTimeString("en-US", {
    hour12: false,
  });

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

class ChatServerTerminalUi {
  private readonly enabled: boolean;
  private readonly originalConsole = {
    error: console.error.bind(console),
    log: console.log.bind(console),
    warn: console.warn.bind(console),
  };
  private readonly startedAt = Date.now();
  private readonly serverInfo: ServerInfo = {
    port: 0,
    serverId: "pending",
    url: "binding websocket server...",
  };
  private snapshot: TerminalUiSnapshot = {
    activeChats: 0,
    broadcastCount: 0,
    broadcastDurationTotalMs: 0,
    chats: [],
    lastBroadcast: null,
    lastLoopLagMs: 0,
    lastPublishedChat: null,
    lastRedistribute: null,
    messageCount: 0,
    status: "starting",
    totalConnections: 0,
  };
  private headerBox?: blessed.Widgets.BoxElement;
  private logBox?: blessed.Widgets.Log;
  private metricsBox?: blessed.Widgets.BoxElement;
  private renderTimer?: NodeJS.Timeout;
  private screen?: blessed.Widgets.Screen;
  private chatBox?: blessed.Widgets.BoxElement;

  constructor() {
    this.enabled = Boolean(process.stdout.isTTY && process.stdin.isTTY);

    if (!this.enabled) {
      return;
    }

    this.screen = blessed.screen({
      smartCSR: true,
      title: "chat-server",
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
      label: " Runtime ",
      style: {
        border: {
          fg: "green",
        },
      },
    });

    this.chatBox = blessed.box({
      parent: this.screen,
      top: 4,
      left: "50%",
      width: "50%",
      height: 13,
      tags: true,
      border: "line",
      label: " Chats ",
      scrollable: true,
      alwaysScroll: true,
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
      width: "100%",
      height: "100%-17",
      tags: false,
      border: "line",
      label: " Event Log ",
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

    this.patchConsole();
    this.render();
    this.renderTimer = setInterval(() => this.render(), 1000);
    this.renderTimer.unref();
  }

  setServerInfo(info: ServerInfo) {
    this.serverInfo.port = info.port;
    this.serverInfo.serverId = info.serverId;
    this.serverInfo.url = info.url;
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

    this.screen?.destroy();
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

    this.logBox?.log(line);
    this.render();
  }

  private render() {
    if (
      !this.enabled ||
      !this.screen ||
      !this.headerBox ||
      !this.metricsBox ||
      !this.chatBox
    ) {
      return;
    }

    this.headerBox.setContent(
      [
        `{bold}chat-server{/bold}  {cyan-fg}${this.snapshot.status}{/cyan-fg}`,
        `server ${this.serverInfo.serverId}  port ${this.serverInfo.port || "-"}  uptime ${formatDuration(this.startedAt)}`,
        this.serverInfo.url,
      ].join("\n"),
    );

    this.metricsBox.setContent(
      [
        `connections      ${this.snapshot.totalConnections}`,
        `active chats     ${this.snapshot.activeChats}`,
        `messages pub     ${this.snapshot.messageCount}`,
        `broadcasts       ${this.snapshot.broadcastCount}`,
        `fanout total     ${this.snapshot.broadcastDurationTotalMs.toFixed(2)} ms`,
        `fanout avg       ${
          this.snapshot.broadcastCount === 0
            ? "0.00"
            : (
                this.snapshot.broadcastDurationTotalMs /
                this.snapshot.broadcastCount
              ).toFixed(2)
        } ms`,
        `loop lag         ${this.snapshot.lastLoopLagMs.toFixed(2)} ms`,
        `last publish     ${this.snapshot.lastPublishedChat ?? "-"}`,
        this.snapshot.lastBroadcast === null
          ? "last broadcast   -"
          : `last broadcast   ${this.snapshot.lastBroadcast.durationMs.toFixed(2)} ms to ${this.snapshot.lastBroadcast.recipients} (${this.snapshot.lastBroadcast.chatId})`,
        this.snapshot.lastRedistribute === null
          ? "redistribute    -"
          : `redistribute    ${this.snapshot.lastRedistribute.redistributeBy} of ${this.snapshot.lastRedistribute.overBy} at ${this.snapshot.lastRedistribute.timestamp}`,
      ].join("\n"),
    );

    const chatLines = [...this.snapshot.chats]
      .sort(
        (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
      )
      .slice(0, MAX_CHAT_LINES)
      .map(([chatId, count]) => `${chatId}  ${count}`);

    this.chatBox.setContent(
      chatLines.length > 0 ? chatLines.join("\n") : "No registered chats yet.",
    );

    this.screen.render();
  }
}

export const terminalUi = new ChatServerTerminalUi();
