import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanupDeadServers,
  healthChecks,
  redistributeLoad,
  shouldSpawnNewServer,
} from "@load-balancer/src/intervals.js";
import { v4 } from "uuid";
import {
  ChildProcess,
  childServerMap,
  serverBlacklist,
} from "@load-balancer/src/utils.js";
import {
  defaultServerState,
  redisRedistributeChannelFactory,
  serversClientCountKey,
  serversHeartbeatKey,
  serversSocketWritesPerSecondKey,
} from "@chat/shared";
import { ChildProcessWithoutNullStreams } from "node:child_process";

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
  });

  describe("redistributeLoad", () => {
    it("redistributes when distribution is above threshold", async () => {
      mockRedisClient.publish = vi.fn();
      const uuid = v4();

      mockRedisClient.zRangeWithScores = vi
        .fn()
        .mockResolvedValueOnce([
          { value: v4(), score: 0 },
          { value: uuid, score: 10 },
        ])
        .mockResolvedValueOnce([{ value: uuid, score: 3 }])
        .mockResolvedValueOnce([]);

      await redistributeLoad();

      expect(mockRedisClient.zRangeWithScores).toHaveBeenCalledTimes(2);
      expect(mockRedisClient.zRangeWithScores).toHaveBeenNthCalledWith(
        1,
        serversClientCountKey,
        0,
        -1,
      );
      expect(mockRedisClient.zRangeWithScores).toHaveBeenNthCalledWith(
        2,
        serversSocketWritesPerSecondKey,
        0,
        -1,
      );
      expect(mockRedisClient.publish).toHaveBeenCalledExactlyOnceWith(
        redisRedistributeChannelFactory(uuid),
        "5",
      );
    });

    it("doesn't trigger redistribution when server is blacklisted", async () => {
      mockRedisClient.publish = vi.fn();
      const now = Date.now();
      vi.useFakeTimers();
      vi.setSystemTime(now);

      const healthyServerOne = v4();
      const healthyServerTwo = v4();
      const deadServer = v4();

      mockRedisClient.zRangeWithScores = vi
        .fn()
        .mockResolvedValueOnce([
          { value: healthyServerOne, score: 500 },
          { value: healthyServerTwo, score: 500 },
          { value: deadServer, score: 500 },
        ])
        .mockResolvedValueOnce([]);

      serverBlacklist.set(deadServer, Date.now());

      await redistributeLoad();

      expect(mockRedisClient.publish).not.toHaveBeenCalled();
    });
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

  describe("cleanupDeadServers", () => {
    it("removes servers that has a ratio key but no timeout key", async () => {
      const uuid = v4();
      mockRedisClient.zRangeByScore = vi
        .fn()
        .mockResolvedValueOnce([uuid])
        .mockResolvedValueOnce(["timeout-server-1"]);
      childServerMap.set(uuid, {
        process: {
          kill: vi.fn(),
          killed: false,
        } as unknown as ChildProcessWithoutNullStreams,
        server: {
          id: uuid,
          url: "ws://localhost:3001",
        },
        state: defaultServerState(),
      });

      await cleanupDeadServers();

      expect(mockRedisClient.zRangeByScore).toHaveBeenCalledTimes(2);
      expect(mockRedisClient.zRangeByScore).toHaveBeenCalledWith(
        ...[serversSocketWritesPerSecondKey, "-inf", "+inf"],
      );
      expect(mockRedisClient.zRangeByScore).toHaveBeenCalledWith(
        serversHeartbeatKey,
        "-inf",
        "+inf",
      );
      expect(mockedRemoveServerFromRedis).toHaveBeenCalledExactlyOnceWith(uuid);
      expect(childServerMap.get(uuid)).toBeUndefined();
    });
  });

  describe("shouldSpawnNewServer", () => {
    const childServerFactory = (overrides: Partial<ChildProcess>) => {
      const id = v4();
      return {
        server: {
          id,
          url: "ws://snickers.com:8080,",
        },
        process: {} as ChildProcessWithoutNullStreams,
        state: defaultServerState(),
        ...overrides,
      };
    };

    it("spawns new server if cumulative socket write load is above max capacity", () => {
      const a = childServerFactory({
        state: {
          ...defaultServerState(),
          socketWrites: [100_000, 100_000, 100_000, 100_000, 100_000],
        },
      });
      childServerMap.set(a.server.id, a);
      const b = childServerFactory({
        state: {
          ...defaultServerState(),
          socketWrites: [100_000, 100_000, 100_000, 100_000, 100_000],
        },
      });
      childServerMap.set(b.server.id, b);
      const c = childServerFactory({
        state: {
          ...defaultServerState(),
          socketWrites: [100_000, 100_000, 100_000, 100_000, 100_000],
        },
      });
      childServerMap.set(c.server.id, c);

      const outcome = shouldSpawnNewServer();

      expect(outcome).toBeTruthy();
    });

    it("spawns new server if one server has average socket load above critical mass", () => {
      const a = childServerFactory({
        state: {
          ...defaultServerState(),
          socketWrites: [100_000, 80_000, 110_000, 50_000, 60_000],
        },
      });
      childServerMap.set(a.server.id, a);

      const outcome = shouldSpawnNewServer();

      expect(outcome).toBeTruthy();
    });
  });
});
