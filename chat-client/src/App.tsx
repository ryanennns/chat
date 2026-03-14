import { useEffect, useRef, useState } from 'react'
import './App.css'

interface ProvisionedServer {
  id: string
  url: string
}

interface ProvisionError {
  error: string
}

interface ChatMessage {
  id: number
  text: string
}

function App() {
  const socketRef = useRef<WebSocket | null>(null)
  const [serverUrl, setServerUrl] = useState('')
  const [status, setStatus] = useState('Idle')
  const [error, setError] = useState('')
  const [draft, setDraft] = useState('')
  const [messages, setMessages] = useState<ChatMessage[]>([])

  useEffect(() => {
    return () => {
      socketRef.current?.close()
    }
  }, [])

  const connect = async () => {
    setError('')
    setStatus('Requesting server...')
    socketRef.current?.close()

    try {
      const response = await fetch('/api/servers/provision')
      const data: ProvisionedServer | ProvisionError = await response.json()

      if ('error' in data) {
        setServerUrl('')
        setStatus('No connection')
        setError(data.error)
        return
      }

      setServerUrl(data.url)
      setStatus('Connecting...')

      const socket = new WebSocket(data.url)
      socketRef.current = socket

      socket.addEventListener('open', () => {
        setStatus('Connected')
      })

      socket.addEventListener('close', () => {
        setStatus('Disconnected')
      })

      socket.addEventListener('message', (event) => {
        setMessages((current) => [
          ...current,
          { id: Date.now() + current.length, text: String(event.data) },
        ])
      })

      socket.addEventListener('error', () => {
        setStatus('Connection failed')
        setError('WebSocket connection failed')
      })
    } catch (err) {
      setServerUrl('')
      setStatus('Request failed')
      setError(err instanceof Error ? err.message : 'Unknown error')
    }
  }

  const sendMessage = () => {
    const socket = socketRef.current

    if (!socket || socket.readyState !== WebSocket.OPEN) {
      setError('No active WebSocket connection')
      return
    }

    if (!draft.trim()) {
      return
    }

    const payload = JSON.stringify({ message: draft })
    socket.send(payload)
    setDraft('')
    setError('')
  }

  return (
    <main className="app">
      <h1>Chat Client</h1>
      <button onClick={connect} type="button">
        Request WSS Server
      </button>
      <p>Status: {status}</p>
      {serverUrl && <p>Server URL: {serverUrl}</p>}
      <div className="chat-box">
        <input
          type="text"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Enter a message"
        />
        <button onClick={sendMessage} type="button">
          Send
        </button>
      </div>
      <div className="messages">
        {messages.map((message) => (
          <p key={message.id}>{message.text}</p>
        ))}
      </div>
      {error && <p className="error">Error: {error}</p>}
    </main>
  )
}

export default App
