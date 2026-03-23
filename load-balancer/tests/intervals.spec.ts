import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  healthChecks,
  updateChatRoomState,
  updateServerState,
} from "@load-balancer/src/intervals.js";
import { v4 } from "uuid";
import { serverBlacklist } from "@load-balancer/src/utils.js";
import {
  chatRoomCumulativeMessages,
  chatRoomSocketWritesPerSecondKey,
  chatRoomTotalClientsKey,
  defaultServerState,
  serversClientCountKey,
  serversEventLoopTimeoutKey,
  serversSocketWritesPerSecondKey,
} from "@chat/shared";
import { chatRooms, socketServers } from "@load-balancer/src/state.js";

const mockRedisClient = vi.hoisted(() => ({
  connect: vi.fn(),
  hGet: vi.fn(),
  publish: vi.fn(),
  subscribe: vi.fn(),
  zRange: vi.fn(),
  zRangeByScore: vi.fn(),
  zRangeWithScores: vi.fn(),
}));
vi.mock("redis", () => {
  return {
    createClient: vi.fn(() => mockRedisClient),
  };
});

let mockedRemoveServerFromRedis = vi.hoisted(() => vi.fn());
vi.mock("@chat/shared", async () => {
  const actual =
    await vi.importActual<typeof import("@chat/shared")>("@chat/shared");

  return {
    ...actual,
    removeServerFromRedis: mockedRemoveServerFromRedis,
  };
});

describe("intervals", () => {
  beforeEach(() => {
    mockedRemoveServerFromRedis.mockClear();
    serverBlacklist.clear();
    chatRooms.clear();
    socketServers.clear();
    vi.useRealTimers();
  });

  describe("healthChecks", () => {
    it("adds timed-out servers to server blacklist", async () => {
      expect(serverBlacklist.size).toBe(0);

      const uuid = v4();
      mockRedisClient.zRangeByScore = vi.fn(() => [uuid]);
      mockRedisClient.zRangeWithScores = vi.fn(() => []);

      await healthChecks();

      expect(serverBlacklist.size).toBe(1);
    });

    it("removes dead servers from redis", async () => {
      expect(serverBlacklist.size).toBe(0);
      const now = Date.now();
      vi.useFakeTimers();
      vi.setSystemTime(now);

      const uuid = v4();
      mockRedisClient.zRangeByScore = vi.fn(() => [uuid]);

      await healthChecks();

      expect(serverBlacklist.size).toBe(1);

      vi.setSystemTime(now + 15_000);

      await healthChecks();

      expect(serverBlacklist.size).toBe(0);
      expect(mockedRemoveServerFromRedis).toHaveBeenCalledOnce();
    });
  });

  describe("updateServerState", () => {
    it("pushes latest values to load balancer state", async () => {
      const serverUuid = v4();
      socketServers.set(serverUuid, {
        server: {
          id: serverUuid,
          url: "ws://localhost:3001",
        },
        process: {
          kill: vi.fn(),
        } as never,
        state: defaultServerState(),
      });

      let serverState = socketServers.get(serverUuid);

      expect(serverState?.state.socketWrites.at(-1)).toBe(0);
      expect(serverState?.state.clients.at(-1)).toBe(0);
      expect(serverState?.state.timeouts.at(-1)).toBe(0);

      mockRedisClient.zRangeWithScores = vi
        .fn()
        .mockReturnValueOnce([
          {
            value: serverUuid,
            score: 1,
          },
        ])
        .mockReturnValueOnce([
          {
            value: serverUuid,
            score: 2,
          },
        ])
        .mockReturnValueOnce([
          {
            value: serverUuid,
            score: 3,
          },
        ]);

      await updateServerState();

      expect(mockRedisClient.zRangeWithScores).toHaveBeenCalledTimes(3);
      [
        serversSocketWritesPerSecondKey,
        serversClientCountKey,
        serversEventLoopTimeoutKey,
      ].forEach((v) =>
        expect(mockRedisClient.zRangeWithScores).toHaveBeenCalledWith(v, 0, -1),
      );

      serverState = socketServers.get(serverUuid);
      expect(serverState?.state.socketWrites.at(-1)).toBe(1);
      expect(serverState?.state.clients.at(-1)).toBe(2);
      expect(serverState?.state.timeouts.at(-1)).toBe(3);
    });
  });

  describe("updateChatRoomState", () => {
    it("pushes latest values to chat room state", async () => {
      const chatRoomId = v4();
      let chatRoomState = chatRooms.get(chatRoomId);

      expect(chatRoomState).toBeUndefined();

      mockRedisClient.zRangeWithScores = vi
        .fn()
        .mockReturnValueOnce([
          {
            value: chatRoomId,
            score: 1,
          },
        ])
        .mockReturnValueOnce([
          {
            value: chatRoomId,
            score: 2,
          },
        ])
        .mockReturnValueOnce([
          {
            value: chatRoomId,
            score: 3,
          },
        ]);

      await updateChatRoomState();

      expect(mockRedisClient.zRangeWithScores).toHaveBeenCalledTimes(3);
      [
        chatRoomSocketWritesPerSecondKey,
        chatRoomCumulativeMessages,
        chatRoomTotalClientsKey,
      ].forEach((v) =>
        expect(mockRedisClient.zRangeWithScores).toHaveBeenCalledWith(v, 0, -1),
      );

      chatRoomState = chatRooms.get(chatRoomId);
      expect(chatRoomState?.cumulativeSocketWrites.at(-1)).toBe(1);
      expect(chatRoomState?.cumulativeMessages.at(-1)).toBe(2);
      expect(chatRoomState?.clients.at(-1)).toBe(3);
    });
  });
});
