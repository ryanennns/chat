import type { Request, Response } from "express";
import { chatRooms, socketServers } from "../state.ts";

export const redisStats = (_req: Request, res: Response) => {
  res.json({
    socketServers: [...socketServers.values()].map((ss) => ({
      server: ss.server,
      state: ss.state,
    })),
    chatRooms: Object.fromEntries(chatRooms),
  });
};
