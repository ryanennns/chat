import { beforeEach, describe, expect, it, vi } from "vitest";
import { healthChecks } from "@load-balancer/src/intervals.js";
import { v4 } from "uuid";
import { serverBlacklist } from "@load-balancer/src/utils.js";

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
});
