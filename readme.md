# chat

simple, scalable chat server / load balancer using redis and node.js

## _inception_

This project came to be one morning when I decided I wanted to spend time looking into Redis.
Specifically, I was interested in trying to recreate Laravel's queue system, though this quickly
took a backseat.

### _Pub/Sub_

I'd never spent any time using Redis beyond a Laravel cache driver, and when I found out about
its pub-sub system it immediately opened up the door to a project I had poked around on years
ago but ultimately failed with; a distributed, websocket driven real-time chat system.

I had heard of the pub-sub pattern but never used it day to day - in short, a publisher more or
less shouts a message into the void, not caring who is there to hear it. Subscribers can listen
for messages, scoped by what is referred to as a _channel_ in Redis' case.

In code (using [`node-redis`](https://www.npmjs.com/package/redis)), it looks something like this:

```typescript
redisClient.subscribe(
  "some-channel",
  (message: string) => console.log(JSON.parse(message))
);

redisClient.publish(
  "some-channel",
  JSON.stringify({
    some: "data"
  })
);
```

This concept, I've since learned, is known as _fanout_ - the distribution of a message across
multiple processes. Crucially, it enables multiple websocket servers to manage the same chat
room simultaneously; if a client connected to `server-a`, that message can be _fanned out_ to
clients connected to `server-b` using Redis' pub-sub system.

In practice, it works something like this:

1. Two clients, `client-a` and `client-b` are connected to `server-a` and `server-b` respectively.
2. `client-a` sends a message over its websocket connection to `client-a`.
3. `server-a` receives this message, publishes it to Redis, and does nothing else with it:
   ```typescript
   client.on("message", async (rawData) => {
     const message = JSON.parse(rawData.toString()) as WebSocketMessage<unknown>;
    
     switch (message.type) {
       case "chat":
       void publishChat(message as WebSocketMessage<ChatPayload>, client);
       break;
       // ...
     }
   });
   
   // ...

   const publishChat = async (
     message: WebSocketMessage<ChatPayload>,
     socket: ClientSocket,
   ) => {
     if (!socket.chatId) {
       return;
     }
     
     void redisClient.publish(socket.chatId, JSON.stringify(message.payload));
   };
   ```
4. snickers


$$
\mathrm{r}=\text{rooms},\quad
\mathrm{u}=\text{users},\quad
\mathrm{m}=\frac{t_{min}+t_{max}}{2}
$$

$$
f(r,u,m)=\frac{u^2}{mr}
$$

![diagram](./diagram.png)

![functions](./functions.png)
