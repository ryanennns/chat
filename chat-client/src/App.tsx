import { useEffect, useRef, useState } from 'react'
import './App.css'

interface ProvisionedServer {
  id: string
  url: string
}

interface ProvisionError {
  error: string
}

function App() {
  const socketRef = useRef<WebSocket | null>(null)
  const [serverUrl, setServerUrl] = useState('')
  const [status, setStatus] = useState('Idle')
  const [error, setError] = useState('')

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

  return (
    <main className="app">
      <h1>Chat Client</h1>
      <button onClick={connect} type="button">
        Request WSS Server
      </button>
      <p>Status: {status}</p>
      {serverUrl && <p>Server URL: {serverUrl}</p>}
      {error && <p className="error">Error: {error}</p>}
    </main>
  )
}

export default App
