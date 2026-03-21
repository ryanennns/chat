export let chatRoomCount = 0;
export let clientCount = 0;
export let notTakingNewConnections = false;
export const incrementChatCount = () => chatRoomCount++;
export const decrementChatCount = () => chatRoomCount--;
export const incrementClientCount = () => clientCount++;
export const decrementClientCount = () => clientCount--;
export const setNotTakingNewConnections = (b: boolean) =>
  (notTakingNewConnections = b);
