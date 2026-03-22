import type { Request, Response } from "express";
import { childServerMap, redisClient } from "../utils.ts";
import {
  serversHeartbeatKey,
  chatRoomTotalMessagesKey,
  chatRoomTotalClientsKey,
} from "@chat/shared";

export const redisStats = async (_req: Request, res: Response) => {
  const now = Date.now();

  const [heartbeats, messageCounts, clientCounts] = await Promise.all([
    redisClient.zRangeWithScores(serversHeartbeatKey, 0, -1),
    redisClient.zRangeWithScores(chatRoomTotalMessagesKey, 0, -1),
    redisClient.zRangeWithScores(chatRoomTotalClientsKey, 0, -1),
  ]);

  const heartbeatMap = new Map(heartbeats.map((e) => [e.value, e.score]));

  const servers = [...childServerMap.entries()].map(([id, child]) => {
    const { state, server } = child;
    const last = state.clients.length - 1;
    return {
      id,
      url: server.url,
      clients: state.clients[last] ?? 0,
      chatRooms: Object.keys(state.chatRooms).length,
      mps: state.socketWrites[last] ?? 0,
      eventLoopTimeout: state.timeouts[last] ?? 0,
      heartbeatAgeMs: now - (heartbeatMap.get(id) ?? 0),
      history: {
        clients: state.clients,
        chatRooms: state.chatRooms,
        socketWrites: state.socketWrites,
        timeouts: state.timeouts,
      },
    };
  });

  servers.sort((a, b) => a.id.localeCompare(b.id));

  res.json({
    ts: now,
    servers,
    totals: {
      clients: servers.reduce((s, sv) => s + sv.clients, 0),
      chatRooms: servers.reduce((s, sv) => s + sv.chatRooms, 0),
      mps: servers.reduce((s, sv) => s + sv.mps, 0),
    },
    chatRooms: {
      messageCounts,
      clientCounts,
    },
  });
};
