import { Room } from "@chat-server/src/utils.js";

export const rooms: Map<string, Room> = new Map();
export let chatRoomCount = 0;
export let clientCount = 0;
export const incrementChatCount = () => chatRoomCount++;
export const decrementChatCount = () => chatRoomCount--;
export const incrementClientCount = () => clientCount++;
export const decrementClientCount = () => clientCount--;
