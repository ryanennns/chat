import type { Request, Response } from "express";
import { childServerMap, redisClient } from "../utils.ts";
import { serversHeartbeatKey } from "@chat/shared";
import { chatRooms } from "../state.ts";

export const redisStats = async (_req: Request, res: Response) => {
  const now = Date.now();

  const heartbeats = await redisClient.zRangeWithScores(
    serversHeartbeatKey,
    0,
    -1,
  );
  const heartbeatMap = new Map(heartbeats.map((e) => [e.value, e.score]));

  const servers = [...childServerMap.entries()].map(([id, child]) => {
    const { state, server } = child;
    const last = state.clients.length - 1;
    return {
      id,
      url: server.url,
      clients: state.clients[last] ?? 0,
      socketWritesPerSecond: state.socketWrites[last] ?? 0,
      eventLoopTimeout: state.timeouts[last] ?? 0,
      heartbeatAgeMs: now - (heartbeatMap.get(id) ?? 0),
      history: {
        clients: state.clients,
        socketWrites: state.socketWrites,
        timeouts: state.timeouts,
      },
    };
  });

  servers.sort((a, b) => a.id.localeCompare(b.id));

  const chatRoomList = [...chatRooms.entries()].map(([id, room]) => {
    const last = room.clients.length - 1;
    return {
      id,
      clients: room.clients[last] ?? 0,
      messagesPerSecond: room.messagesPerSecond[last] ?? 0,
      socketWritesPerSecond: room.socketWritesPerSecond[last] ?? 0,
      history: {
        clients: room.clients,
        messagesPerSecond: room.messagesPerSecond,
        socketWritesPerSecond: room.socketWritesPerSecond,
      },
    };
  });

  res.json({
    ts: now,
    servers,
    chatRooms: chatRoomList,
    totals: {
      clients: servers.reduce((s, sv) => s + sv.clients, 0),
      chatRooms: chatRoomList.length,
      socketWritesPerSecond: chatRoomList.reduce(
        (s, r) => s + r.socketWritesPerSecond,
        0,
      ),
    },
  });
};
