import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanupDeadServers,
  healthChecks,
  redistributeLoad,
} from "@load-balancer/src/intervals.js";
import { v4 } from "uuid";
import { childServerMap, serverBlacklist } from "@load-balancer/src/utils.js";
import {
  redisRedistributeChannelFactory,
  serversRatioKey,
  serversTimeoutKey,
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

      mockRedisClient.zRangeWithScores = vi.fn(() => {
        return [
          { value: v4(), score: 0 },
          { value: uuid, score: 10 },
        ];
      });

      await redistributeLoad();

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

      mockRedisClient.zRangeWithScores = vi.fn(() => {
        return [
          { value: healthyServerOne, score: 500 },
          { value: healthyServerTwo, score: 500 },
          { value: deadServer, score: 500 },
        ];
      });

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
        kill: vi.fn(),
      } as unknown as ChildProcessWithoutNullStreams);

      await cleanupDeadServers();

      expect(mockRedisClient.zRangeByScore).toHaveBeenCalledTimes(2);
      expect(mockRedisClient.zRangeByScore).toHaveBeenCalledWith(
        ...[serversRatioKey, "-inf", "+inf"],
      );
      expect(mockRedisClient.zRangeByScore).toHaveBeenCalledWith(
        serversTimeoutKey,
        "-inf",
        "+inf",
      );
      expect(mockedRemoveServerFromRedis).toHaveBeenCalledExactlyOnceWith(uuid);
      expect(childServerMap.get(uuid)).toBeUndefined();
    });
  });
});
