import { NumericList } from "@chat/shared";

export const chatRoomClientHistory: Record<string, NumericList> = {};
export let lastSpawnedServer = Date.now();
export const setLastSpawnedServer = (time: number) =>
  (lastSpawnedServer = time);
