import { useEffect, useRef, useState } from "react";
import "./App.css";
import type { ClientMessage } from "@chat/shared";
import { Monitor } from "./Monitor.tsx";

interface ProvisionedServer {
  id: string;
  url: string;
}

interface ProvisionError {
  error: string;
}

interface ChatMessage {
  id: number;
  text: string;
}

const MAX_MESSAGES = 100;

function App() {
  const socketRef = useRef<WebSocket | null>(null);
  const messageIdRef = useRef(0);
  const [view, setView] = useState<"chat" | "monitor">("chat");
  const [chatRoomId, setChatRoomId] = useState("chat-room-1");
  const [serverUrl, setServerUrl] = useState("");
  const [status, setStatus] = useState("Idle");
  const [error, setError] = useState("");
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);

  useEffect(() => {
    return () => {
      socketRef.current?.close();
    };
  }, []);

  const pushMessage = (text: string) => {
    const nextMessage = {
      id: messageIdRef.current,
      text,
    };

    messageIdRef.current += 1;

    setMessages((current) => [nextMessage, ...current].slice(0, MAX_MESSAGES));
  };

  const connect = async () => {
    setError("");
    setStatus("Requesting server...");
    socketRef.current?.close();

    try {
      const response = await fetch("/api/servers/provision");
      const data: ProvisionedServer | ProvisionError = await response.json();

      if ("error" in data) {
        setServerUrl("");
        setStatus("No connection");
        setError(data.error);
        return;
      }

      setServerUrl(data.url);
      setStatus("Connecting...");

      const socket = new WebSocket(data.url);
      socketRef.current = socket;

      socket.addEventListener("open", () => {
        setStatus("Connected");

        socket.send(
          JSON.stringify({
            type: "register",
            payload: {
              chatId: chatRoomId.trim() || "chat-room-1",
            },
          }),
        );
      });

      socket.addEventListener("close", () => {
        setStatus("Disconnected");
      });

      socket.addEventListener("message", (event) => {
        console.log(event.data);
        pushMessage(String(event.data));
      });

      socket.addEventListener("error", () => {
        setStatus("Connection failed");
        setError("WebSocket connection failed");
      });
    } catch (err) {
      setServerUrl("");
      setStatus("Request failed");
      setError(err instanceof Error ? err.message : "Unknown error");
    }
  };

  const sendChatMessage = () => {
    const socket = socketRef.current;

    if (!socket || socket.readyState !== WebSocket.OPEN) {
      setError("No active WebSocket connection");
      return;
    }

    if (!draft.trim()) {
      return;
    }

    const payload: ClientMessage<ChatMessage> = {
      type: "chat",
      payload: {
        message: draft,
      },
    };
    socket.send(JSON.stringify(payload));
    setDraft("");
    setError("");
  };

  return (
    <main className="app">
      <div className="nav">
        <h1>Chat Client</h1>
        <div className="nav-tabs">
          <button
            type="button"
            className={view === "chat" ? "nav-tab nav-tab--active" : "nav-tab"}
            onClick={() => setView("chat")}
          >
            chat
          </button>
          <button
            type="button"
            className={
              view === "monitor" ? "nav-tab nav-tab--active" : "nav-tab"
            }
            onClick={() => setView("monitor")}
          >
            monitor
          </button>
        </div>
      </div>

      {view === "monitor" && <Monitor />}
      {view === "chat" && (
        <>
          <button onClick={connect} type="button">
            Request WSS Server
          </button>
          <p>Status: {status}</p>
          {serverUrl && <p>Server URL: {serverUrl}</p>}
          <div className="chat-box">
            <input
              type="text"
              value={chatRoomId}
              onChange={(event) => setChatRoomId(event.target.value)}
              placeholder="Enter chat room ID"
            />
          </div>
          <div className="chat-box">
            <input
              type="text"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="Enter a message"
            />
            <button onClick={sendChatMessage} type="button">
              Send
            </button>
          </div>
          <div className="messages">
            {messages.map((message) => (
              <p key={message.id}>{message.text}</p>
            ))}
          </div>
          {error && <p className="error">Error: {error}</p>}
        </>
      )}
    </main>
  );
}

export default App;
