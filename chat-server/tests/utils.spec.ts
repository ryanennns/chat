import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ClientSocket,
  flushRoom,
  redistributeBy,
  redistributePayload,
  Room,
  setRedistributeBy,
} from "@chat-server/src/utils.js";

describe("flushRoom", () => {
  const mockClientSocket = {
    readyState: WebSocket.OPEN,
    send: vi.fn(),
  };

  const set = new Set<ClientSocket>();
  set.add(mockClientSocket as unknown as ClientSocket);

  beforeEach(() => (mockClientSocket.send = vi.fn()));

  it("flushes messages from the queue", () => {
    const messageQueue = ["1"];

    const room: Room = {
      clients: set,
      queue: [...messageQueue],
      running: true,
    };

    flushRoom(room);

    expect(mockClientSocket.send).toHaveBeenCalledTimes(messageQueue.length);
    messageQueue.forEach((message) =>
      expect(mockClientSocket.send).toHaveBeenCalledWith(message),
    );
  });

  it("sends redistribute payload instead of message if redistributeBy > 0", () => {
    setRedistributeBy(1);

    const messageQueue = ["1"];

    const room: Room = {
      clients: set,
      queue: [...messageQueue],
      running: false,
    };

    flushRoom(room);

    expect(mockClientSocket.send).toHaveBeenCalledExactlyOnceWith(
      JSON.stringify(redistributePayload),
    );
    expect(redistributeBy).toEqual(0);
  });
});
