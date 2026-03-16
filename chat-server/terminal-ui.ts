/**
 * this file is fully vibe coded
 */

import blessed from "blessed";
import { format } from "node:util";

interface ServerInfo {
  port: number;
  serverId: string;
  url: string;
}

interface RedistributeEvent {
  overBy: number;
  redistributeBy: number;
  timestamp: string;
}

interface BroadcastEvent {
  chatId: string;
  durationMs: number;
  recipients: number;
  timestamp: string;
}

interface UiState {
  activeChats: number;
  broadcastCount: number;
  chats: Map<string, number>;
  lastBroadcast: BroadcastEvent | null;
  lastLoopLagMs: number;
  lastPublishedChat: string | null;
  lastRedistribute: RedistributeEvent | null;
  messageCount: number;
  port: number | null;
  serverId: string | null;
  startedAt: number;
  status: string;
  totalConnections: number;
  url: string | null;
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
  private readonly state: UiState = {
    activeChats: 0,
    broadcastCount: 0,
    chats: new Map(),
    lastBroadcast: null,
    lastLoopLagMs: 0,
    lastPublishedChat: null,
    lastRedistribute: null,
    messageCount: 0,
    port: null,
    serverId: null,
    startedAt: Date.now(),
    status: "starting",
    totalConnections: 0,
    url: null,
  };
  private readonly originalConsole = {
    error: console.error.bind(console),
    log: console.log.bind(console),
    warn: console.warn.bind(console),
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
    this.state.port = info.port;
    this.state.serverId = info.serverId;
    this.state.url = info.url;
    this.state.status = "running";
    this.render();
  }

  setStatus(status: string) {
    this.state.status = status;
    this.render();
  }

  noteConnectionDelta(delta: number) {
    this.state.totalConnections = Math.max(
      0,
      this.state.totalConnections + delta,
    );
    this.render();
  }

  setChatConnectionCount(chatId: string, count: number) {
    if (count <= 0) {
      this.state.chats.delete(chatId);
    } else {
      this.state.chats.set(chatId, count);
    }

    this.state.activeChats = this.state.chats.size;
    this.render();
  }

  noteLoopLag(durationMs: number) {
    this.state.lastLoopLagMs = durationMs;
    this.render();
  }

  noteBroadcast(chatId: string, recipients: number, durationMs: number) {
    this.state.broadcastCount += 1;
    this.state.lastBroadcast = {
      chatId,
      durationMs,
      recipients,
      timestamp: timestamp(),
    };
    this.render();
  }

  notePublished(chatId: string) {
    this.state.messageCount += 1;
    this.state.lastPublishedChat = chatId;
    this.render();
  }

  noteRedistribute(overBy: number, redistributeBy: number) {
    this.state.lastRedistribute = {
      overBy,
      redistributeBy,
      timestamp: timestamp(),
    };
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
        `{bold}chat-server{/bold}  {cyan-fg}${this.state.status}{/cyan-fg}`,
        `server ${this.state.serverId ?? "pending"}  port ${this.state.port ?? "-"}  uptime ${formatDuration(this.state.startedAt)}`,
        this.state.url ?? "binding websocket server...",
      ].join("\n"),
    );

    this.metricsBox.setContent(
      [
        `connections      ${this.state.totalConnections}`,
        `active chats     ${this.state.activeChats}`,
        `messages pub     ${this.state.messageCount}`,
        `broadcasts       ${this.state.broadcastCount}`,
        `loop lag         ${this.state.lastLoopLagMs.toFixed(2)} ms`,
        `last publish     ${this.state.lastPublishedChat ?? "-"}`,
        this.state.lastBroadcast === null
          ? "last broadcast   -"
          : `last broadcast   ${this.state.lastBroadcast.durationMs.toFixed(2)} ms to ${this.state.lastBroadcast.recipients} (${this.state.lastBroadcast.chatId})`,
        this.state.lastRedistribute === null
          ? "redistribute    -"
          : `redistribute    ${this.state.lastRedistribute.redistributeBy} of ${this.state.lastRedistribute.overBy} at ${this.state.lastRedistribute.timestamp}`,
      ].join("\n"),
    );

    const chatLines = [...this.state.chats.entries()]
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
