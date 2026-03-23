import type { Request, Response } from "express";
import { chatRooms, socketServers } from "../state.ts";

export const redisStats = (_req: Request, res: Response) => {
  const now = Date.now();

  const servers = [...socketServers.entries()].map(([id, child]) => {
    const { state, server } = child;
    const last = state.clients.length - 1;
    const rooms = Object.entries(state.chatRooms)
      .map(([roomId, clients]) => ({ id: roomId, clients }))
      .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
    return {
      id,
      url: server.url,
      clients: state.clients[last] ?? 0,
      socketWritesPerSecond: state.socketWrites[last] ?? 0,
      eventLoopTimeout: state.timeouts[last] ?? 0,
      rooms,
      history: {
        clients: state.clients,
        socketWrites: state.socketWrites,
        timeouts: state.timeouts,
      },
    };
  });

  servers.sort((a, b) => a.id.localeCompare(b.id));

  const chatRoomList = [...chatRooms.entries()].map(([id, room]) => {
    return {
      id,
      clients: room.clients.last() ?? 0,
      messagesPerSecond: room.cumulativeMessages.deltas().last(),
      socketWritesPerSecond: room.cumulativeSocketWrites.deltas().last(),
      history: {
        clients: room.clients,
        messagesPerSecond: room.cumulativeMessages,
        socketWritesPerSecond: room.cumulativeSocketWrites,
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
