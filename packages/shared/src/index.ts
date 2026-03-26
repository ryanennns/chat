import { createClient } from "redis";

export interface Server {
  id: string;
  url: string;
}

export class NumericList extends Array<number> {
  max() {
    return Math.max(...this);
  }

  min() {
    return Math.min(...this);
  }

  average() {
    return this.reduce((a, b) => a + b) / this.length;
  }

  rotate(n: number) {
    this.shift();
    this.push(n);
  }

  first() {
    return this[0];
  }

  last() {
    return this[this.length - 1];
  }

  lastN(n: number) {
    return NumericList.fromArray(this.slice(this.length - n, this.length));
  }

  deltas() {
    const deltas = NumericList.fromArray(
      this.map((v, i) => v - (this[i - 1] ?? 0)),
    );
    deltas.shift();
    return deltas;
  }

  takeEvery(n: number) {
    return NumericList.fromArray(this.filter((_, i) => i % n === 0));
  }

  static fromArray(a: Array<number>) {
    return new NumericList(...a);
  }

  toArray() {
    return new Array<number>(...this);
  }

  trendScore(k = 3) {
    if (this.length < 2) {
      return 0;
    }

    let sum = 0;
    let count = 0;

    for (let i = 1; i < this.length; i++) {
      const prev = this[i - 1];
      const curr = this[i];
      const ratio = curr / prev;
      if (!isFinite(ratio) || ratio <= 0) continue;

      sum += Math.log(curr / prev);
      count++;
    }

    if (count === 0) {
      return 0;
    }

    const avg = sum / count;
    return Math.tanh(k * avg);
  }
}

export type HistoryKey = Exclude<
  {
    [K in keyof ServerState]: ServerState[K] extends NumericList ? K : never;
  }[keyof ServerState],
  "chatRooms"
>;

export interface MemoryUsage {
  rss: number;
  heapTotal: number;
  heapUsed: number;
  external: number;
  arrayBuffers: number;
}

export interface ServerState {
  clients: NumericList;
  socketWrites: NumericList;
  timeouts: NumericList;
  fanouts: NumericList;
  chatRooms: Record<string, number>;
  memory: MemoryUsage;
}
export const serverStateFactory = (): ServerState => ({
  clients: new NumericList(...Array.from({ length: 100 }).map(() => 0)),
  socketWrites: new NumericList(...Array.from({ length: 100 }).map(() => 0)),
  timeouts: new NumericList(...Array.from({ length: 100 }).map(() => 0)),
  fanouts: new NumericList(...Array.from({ length: 100 }).map(() => 0)),
  chatRooms: {},
  memory: { rss: 0, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 },
});

export const redistributeChannel = "wss-redistribute";
export const serversClientCountKey = "servers:clients";
export const serversHeartbeatKey = "servers:heartbeat";
export const serversCumulativeSocketWritesKey =
  "servers:cumulative-socket-writes";
export const serversEventLoopTimeoutKey = "servers:event-loop";
export const serversFanoutCounterKey = "servers:fanout";
export const chatRoomCumulativeSocketWrites =
  "chat-rooms:cumulative-socket-writes";
export const chatRoomCumulativeMessages = "chat-rooms:cumulative-messages";
export const chatRoomTotalClientsKey = "chat-rooms:clients";
export const redisRedistributeChannelFactory = (serverId: string) =>
  `${serverId}-${redistributeChannel}`;
export const redisServerKeyFactory = (serverId: string) => `server:${serverId}`;
export const redisChatCountKeyFactory = (chatChannel: string) =>
  `chat:${chatChannel}`;

export const addServerToRedis = async (server: Server) => {
  const redisClient = createClient();
  await redisClient.connect();

  await redisClient.hSet(redisServerKeyFactory(server.id), {
    serverId: server.id,
    url: server.url,
  });
  await redisClient.zAdd(serversClientCountKey, {
    score: 0,
    value: server.id,
  });
  await redisClient.zAdd(serversHeartbeatKey, {
    score: Date.now(),
    value: server.id,
  });
  await redisClient.zAdd(serversCumulativeSocketWritesKey, {
    score: 0,
    value: server.id,
  });

  redisClient.destroy();
};

export const removeServerFromRedis = async (serverId: string) => {
  const redisClient = createClient();
  await redisClient.connect();

  await redisClient.del(redisServerKeyFactory(serverId));
  await redisClient.zRem(serversClientCountKey, serverId);
  await redisClient.zRem(serversHeartbeatKey, serverId);
  await redisClient.zRem(serversCumulativeSocketWritesKey, serverId);

  redisClient.destroy();
};

export interface WebSocketMessage<T> {
  type: "chat" | "register" | "redistribute";
  payload: T;
}

// server --> client, client --> server
// standard chat message payload
export interface ChatPayload {
  message: string;
}

// client --> server; informs the server
// which chat they are registering to, so
// the server can sub to redis channel
export interface RegistrationPayload {
  chatId: string;
}

// server --> client; informs client to
// ask server for new wss connection for
// rebalancing purposes
export interface RedistributionPayload {
  reason: string;
  redirect: string | undefined;
}

declare const process: {
  env: Record<string, string | undefined>;
};

export const debugLog = (message: any) => {
  if (process.env.CHAT_DEBUG_LOG === "true") {
    console.log(message);
  }
};

export const getLowestLoadServers = async (
  count?: number | undefined,
): Promise<Array<{ id: string; url: string }>> => {
  const redisClient = createClient();
  await redisClient.connect();

  const ids = await redisClient.zRange(
    serversClientCountKey,
    0,
    (count ?? 100) - 1,
  );

  const results: Array<{ id: string; url: string }> = [];

  for (const id of ids) {
    const url = await redisClient.hGet(redisServerKeyFactory(id), "url");
    if (url) {
      results.push({ id, url });
    }
  }

  redisClient.destroy();

  return results;
};

export const getLowestLoadServer = async (): Promise<Server | undefined> => {
  const server = (await getLowestLoadServers())[0];

  if (!server) {
    return undefined;
  }

  return server;
};
