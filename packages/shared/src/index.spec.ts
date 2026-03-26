import { beforeEach, describe, expect, it, vi } from "vitest";

const mockRedisClient = vi.hoisted(() => ({
  connect: vi.fn(),
  destroy: vi.fn(),
  hGet: vi.fn(),
  zRange: vi.fn(),
}));

vi.mock("redis", () => ({
  createClient: vi.fn(() => mockRedisClient),
}));

import {
  getLowestLoadServer,
  getLowestLoadServers,
  NumericList,
} from "./index.js";

describe("shared redis helpers", () => {
  beforeEach(() => {
    mockRedisClient.connect.mockReset();
    mockRedisClient.destroy.mockReset();
    mockRedisClient.hGet.mockReset();
    mockRedisClient.zRange.mockReset();
  });

  describe("getLowestLoadServers", () => {
    it("returns an empty list if no server ids are found", async () => {
      mockRedisClient.zRange.mockResolvedValue([]);

      const result = await getLowestLoadServers(1);

      expect(mockRedisClient.connect).toHaveBeenCalledOnce();
      expect(mockRedisClient.zRange).toHaveBeenCalledOnce();
      expect(mockRedisClient.hGet).not.toHaveBeenCalled();
      expect(mockRedisClient.destroy).toHaveBeenCalledOnce();
      expect(result).toEqual([]);
    });

    it("skips server ids that do not have a URL", async () => {
      const serverId = "server-1";
      mockRedisClient.zRange.mockResolvedValue([serverId]);
      mockRedisClient.hGet.mockResolvedValue(undefined);

      const result = await getLowestLoadServers(1);

      expect(mockRedisClient.zRange).toHaveBeenCalledOnce();
      expect(mockRedisClient.hGet).toHaveBeenCalledOnce();
      expect(mockRedisClient.hGet).toHaveBeenCalledWith(
        `server:${serverId}`,
        "url",
      );
      expect(result).toEqual([]);
    });

    it("returns the lowest-load servers with URLs", async () => {
      const firstId = "server-1";
      const secondId = "server-2";
      mockRedisClient.zRange.mockResolvedValue([firstId, secondId]);
      mockRedisClient.hGet
        .mockResolvedValueOnce("ws://one.test:8080")
        .mockResolvedValueOnce("ws://two.test:8080");

      const result = await getLowestLoadServers(2);

      expect(mockRedisClient.zRange).toHaveBeenCalledOnce();
      expect(mockRedisClient.hGet).toHaveBeenCalledTimes(2);
      expect(result).toEqual([
        { id: firstId, url: "ws://one.test:8080" },
        { id: secondId, url: "ws://two.test:8080" },
      ]);
    });
  });

  describe("getLowestLoadServer", () => {
    it("returns the first lowest-load server", async () => {
      mockRedisClient.zRange.mockResolvedValue(["server-1"]);
      mockRedisClient.hGet.mockResolvedValue("ws://one.test:8080");

      const result = await getLowestLoadServer();

      expect(mockRedisClient.zRange).toHaveBeenCalledOnce();
      expect(result).toEqual({
        id: "server-1",
        url: "ws://one.test:8080",
      });
    });

    it("returns undefined when no valid server exists", async () => {
      mockRedisClient.zRange.mockResolvedValue([]);

      const result = await getLowestLoadServer();

      expect(result).toBeUndefined();
    });
  });

  describe("NumericList", () => {
    it("calculates deltas", () => {
      const list = NumericList.fromArray([1, 2, 3, 4, 5]);

      expect(list.deltas().toArray()).toEqual([1, 1, 1, 1]);
    });

    it("takes every n'th element", () => {
      const list = NumericList.fromArray([
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
      ]);

      expect(list.takeEvery(4).toArray()).toEqual([1, 5, 9]);
    });
  });
});
