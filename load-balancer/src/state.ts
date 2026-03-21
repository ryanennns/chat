export let lastSpawnedServer = Date.now();
export const setLastSpawnedServer = (time: number) =>
  (lastSpawnedServer = time);
