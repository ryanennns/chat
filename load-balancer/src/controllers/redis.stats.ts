// this is all AI generated
import type { Request, Response } from "express";
import { childServerMap, redisClient } from "../utils.ts";
import {
  serversChatRoomsCountKey,
  serversClientCountKey,
  serversEventLoopTimeoutKey,
  serversHeartbeatKey,
  serversSocketWritesPerSecondKey,
  redisServerKeyFactory,
} from "@chat/shared";

export const redisStats = async (_req: Request, res: Response) => {
  const now = Date.now();

  const [clients, chatRooms, heartbeats, mps, eventLoop] = await Promise.all([
    redisClient.zRangeWithScores(serversClientCountKey, 0, -1),
    redisClient.zRangeWithScores(serversChatRoomsCountKey, 0, -1),
    redisClient.zRangeWithScores(serversHeartbeatKey, 0, -1),
    redisClient.zRangeWithScores(serversSocketWritesPerSecondKey, 0, -1),
    redisClient.zRangeWithScores(serversEventLoopTimeoutKey, 0, -1),
  ]);

  const serverIds = new Set([
    ...clients.map((e) => e.value),
    ...heartbeats.map((e) => e.value),
    ...mps.map((e) => e.value),
  ]);

  const servers = await Promise.all(
    [...serverIds].map(async (id) => {
      const url =
        (await redisClient.hGet(redisServerKeyFactory(id), "url")) ?? null;
      const state = childServerMap.get(id)?.state;
      return {
        id,
        url,
        clients: clients.find((e) => e.value === id)?.score ?? 0,
        chatRooms: chatRooms.find((e) => e.value === id)?.score ?? 0,
        mps: mps.find((e) => e.value === id)?.score ?? 0,
        eventLoopTimeout: eventLoop.find((e) => e.value === id)?.score ?? 0,
        heartbeatAgeMs:
          now - (heartbeats.find((e) => e.value === id)?.score ?? 0),
        history: {
          clients: state?.clients ?? [],
          chatRooms: state?.chatRooms ?? [],
          socketWrites: state?.socketWrites ?? [],
          timeouts: state?.timeouts ?? [],
        },
      };
    }),
  );

  servers.sort((a, b) => a.id.localeCompare(b.id));

  res.json({
    ts: now,
    servers,
    totals: {
      clients: servers.reduce((s, sv) => s + sv.clients, 0),
      chatRooms: servers.reduce((s, sv) => s + sv.chatRooms, 0),
      mps: servers.reduce((s, sv) => s + sv.mps, 0),
    },
  });
};
