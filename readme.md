# chat

This project came to be one morning when I decided I wanted to spend time looking into Redis.
Specifically, I was interested in trying to recreate Laravel's queue system, though this quickly
took a backseat.

## The Chat Server

### _Pub/Sub_

I'd never spent any time using Redis beyond a Laravel cache driver, and when I found out about
its pub-sub system it immediately opened up the door to a project I had poked around on years
ago but ultimately failed with; a distributed, websocket driven real-time chat system.

I had heard of the pub-sub pattern but never used it day to day - in short, a publisher more or
less shouts a message into the void, not caring who is there to hear it. Subscribers can listen
for messages, scoped by what is referred to as a _channel_ in Redis' case.

In code (using [`node-redis`](https://www.npmjs.com/package/redis)), it looks something like this:

```typescript
redisClient.subscribe("some-channel", (message: string) =>
  console.log(JSON.parse(message)),
);

redisClient.publish(
  "some-channel",
  JSON.stringify({
    some: "data",
  }),
);
```

This concept, I've since learned, is known as _fanout_ - the distribution of a message across
multiple processes. Crucially, it enables multiple websocket servers to manage the same chat
room simultaneously; if a client connected to `server-a`, that message can be _fanned out_ to
clients connected to `server-b` using Redis' pub-sub system.

In practice, it works something like this:

1. Two clients, `client-a` and `client-b` are connected to `server-a` and `server-b` respectively.
2. `client-a` sends a message over its websocket connection to `client-a`.
3. `server-a` receives this message, publishes it to Redis on the chat channel, and does nothing else with it:

   ```typescript
   client.on("message", async (rawData) => {
     const message = JSON.parse(
       rawData.toString(),
     ) as WebSocketMessage<unknown>;

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

4. `server-a` and `server-b` are subscribed to the respective chat channel, and distributes these received
   messages to its clients:
   ```typescript
   await subscriber.subscribe(chatChannel, (message: string) => {
     // the real implementation doesn't immediately iterate over chat channel
     // sockets and forward the message to each of them, but for clarity that
     // is how i'll show it here :)
     const room = rooms.get(/* chat room ID */);
     room.clients.forEach((socket) => {
       socket.send(message);
     });
   });
   ```

This is the basic back-and-forth between clients, servers and Redis; clients send messages, servers push incoming
messages to Redis, Redis fans these messages out to each server, and servers push Redis-provided messages to the
appropriate clients.

### _Calculating Server Load_

The process of fanning messages out across multiple servers and the subsequent process of each server writing
these messages to potentially hundreds of users who, in turn, are sending cumulatively hundreds of messages per
second, leads to quite a high load on the websockets. Because of this, it's useful to have a simple
calculation to determine the total load on the system as measured in cumulative websocket connection writes per
second.

Given $r$ is the number of chat rooms being serviced (5 chat rooms), $u$ is the number users connected to the chat
service (100 users), and $m$ is the average interval at which messages are sent (every 30 seconds), we can
derive the following formula:

$$
\mathrm{r}=\text{rooms},\quad
\mathrm{u}=\text{users},\quad
\mathrm{m}=\frac{t_{min}+t_{max}}{2}
$$

$$
f(r,u,m)=\frac{u^2}{mr}
$$

$$
f(5, 100, 30) = \frac{100^2}{5 \cdot 30} = 66.67\text{ socket writes per second}
$$

Given these calculations, and an observed maximum of _about_ ~75,000 socket writes per second per server, we
can easily determine the number of servers we'll need to service users in any given circumstance.

#### _"but Ryan, this calculation is too simplistic!"_

Yeah, it is - for instance this projection (and most of my testing) naively assumes an equal distribution of
users per room, where in reality some chat rooms will have far more users than others. Regardless, this formula
proved incredibly useful for testing purposes and, in a pinch, I'm sure would prove a useful calculation even in
a production environment. Regardless, it could be greatly improved by removing the room parameter entirely and
running this calculation on a per-room basis.

## The Load Balancer

Clients ought not to connect directly to a websocket socket server. Instead, they should ask some tertiary service
that will determine what server has the most availability and return those server details to the client, at which
point the client will connect accordingly.

This is our opportunity to create some kind of load balancer, in a true sense of the term. The tools for the job proved
to be `Express.js`, `setInterval`, and `node:child_process`.

### Load Balancer × Chat Server Coupling

I've gone through a few different phases of the load balancer, and with that the relationship between it and the
chat server has evolved. At first, a chat server instance was only _implied_ to exist by an existing heartbeat value
(UNIX timestamp) stored in Redis - the load balancer reads these heartbeats from Redis and determines what servers
are available to it through this. This was a useful paradigm up until the time to spawn new servers came into play.
The load balancer could, indeed, balance the load between chat servers - but it _couldn't_ spawn a new server if load
exceeded that which the current servers could sustain.

This led me to a subprocess model, and sent me down the rabbit hole of `node:child_process` - the load balancer now
manages a set of child processes that it spins up when there is demonstrated need for it. This rendered a lot of
server state storage that previously lived in Redis redundant, and is now stored in memory in the load balancer. The
source of truth for what servers exist is a property of the load balancer itself.

### Server Interface

The load balancer's mental model of what servers are available to it live in the `socketServers` `Map<string, ChildProcess>`;
a somewhat Frankenstein type:

```typescript
import type { ChildProcessWithoutNullStreams } from "node:child_process";

export interface Server {
  id: string;
  url: string;
}

export interface ServerState {
  clients: Array<number>;
  socketWrites: Array<number>;
  timeouts: Array<number>;
  chatRooms: Record<string, number>;
}

export interface ChildProcess {
  server: Server;
  process: ChildProcessWithoutNullStreams;
  state: ServerState;
}
```

The `Server` was the first iteration of the type that would eventually become `ChildProcess` (and is still used) across
the project, hence it (unfortunately) still exists. This is the payload that is returned from the load balancer API. The
`ServerState` type maintains a history of some of the metrics that the chat server pushes to Redis every 1000ms - the
number of clients, the event loop timeout, and the cumulative number of socket writes it has published. Additionally, we
track the chat rooms that the Server is servicing in the form of a `string` (ID) → `number` (# of clients) `Record`.

![diagram](./diagram.png)

![functions](./functions.png)
