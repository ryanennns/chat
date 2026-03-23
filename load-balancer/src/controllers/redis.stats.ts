import type { Request, Response } from "express";
import { childServerMap, redisClient } from "../utils.ts";
import {
  serversHeartbeatKey,
  chatRoomSocketWritesPerSecondKey,
  chatRoomTotalClientsKey,
} from "@chat/shared";

export const redisStats = async (_req: Request, res: Response) => {
  const now = Date.now();

  const [heartbeats, messageCounts, clientCounts] = await Promise.all([
    redisClient.zRangeWithScores(serversHeartbeatKey, 0, -1),
    redisClient.zRangeWithScores(chatRoomSocketWritesPerSecondKey, 0, -1),
    redisClient.zRangeWithScores(chatRoomTotalClientsKey, 0, -1),
  ]);

  const heartbeatMap = new Map(heartbeats.map((e) => [e.value, e.score]));

  const servers = [...childServerMap.entries()].map(([id, child]) => {
    const { state, server } = child;
    const last = state.clients.length - 1;
    const chatRoomSocketWrites = Object.fromEntries(
      Object.entries(state.chatRoomSocketWrites).map(([room, list]) => [
        room,
        list[list.length - 1] ?? 0,
      ]),
    );
    return {
      id,
      url: server.url,
      clients: state.clients[last] ?? 0,
      chatRooms: state.chatRoomMessages,
      chatRoomSocketWrites,
      mps: state.socketWrites[last] ?? 0,
      eventLoopTimeout: state.timeouts[last] ?? 0,
      heartbeatAgeMs: now - (heartbeatMap.get(id) ?? 0),
      history: {
        clients: state.clients,
        chatRooms: state.chatRoomMessages,
        socketWrites: state.socketWrites,
        timeouts: state.timeouts,
        chatRoomSocketWrites: Object.fromEntries(
          Object.entries(state.chatRoomSocketWrites).map(([room, list]) => [
            room,
            [...list],
          ]),
        ),
      },
    };
  });

  servers.sort((a, b) => a.id.localeCompare(b.id));

  res.json({
    ts: now,
    servers,
    totals: {
      clients: servers.reduce((s, sv) => s + sv.clients, 0),
      chatRooms: servers.reduce(
        (s, sv) => s + Object.values(sv.chatRooms).length,
        0,
      ),
      mps: servers.reduce((s, sv) => s + sv.mps, 0),
    },
    chatRooms: {
      messageCounts,
      clientCounts,
    },
  });
};
