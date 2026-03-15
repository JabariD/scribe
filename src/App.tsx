import { useState, useEffect, useCallback } from 'react'
import { invoke } from '@tauri-apps/api/tauri'
import { writeText } from '@tauri-apps/api/clipboard'
import { sendNotification } from '@tauri-apps/api/notification'
import { listen } from '@tauri-apps/api/event'

type Status = 'idle' | 'recording' | 'paused' | 'processing' | 'success' | 'error'

// Default prompt for better technical term recognition
const DEFAULT_PROMPT = `Technical terms: TypeScript, JavaScript, React, useState, useEffect, async, await, API, JSON, npm, git, GitHub, VS Code, macOS, iOS, Android`

function App() {
  const [status, setStatus] = useState<Status>('idle')
  const [transcript, setTranscript] = useState<string>('')
  const [error, setError] = useState<string>('')
  const [audioLevel, setAudioLevel] = useState<number>(0)
  const [apiKey, setApiKey] = useState<string>('')
  const [model, setModel] = useState<string>('whisper-1')
  const [prompt, setPrompt] = useState<string>(DEFAULT_PROMPT)

  // Load saved settings on mount
  useEffect(() => {
    invoke<string>('get_api_key').then(key => {
      if (key) setApiKey(key)
    }).catch(() => {})
    invoke<string>('get_model').then(m => {
      if (m) setModel(m)
    }).catch(() => {})
  }, [])

  // Save API key when changed
  const handleApiKeyChange = async (key: string) => {
    setApiKey(key)
    try {
      await invoke('set_api_key', { apiKey: key })
    } catch (e) {
      console.error('Failed to save API key:', e)
    }
  }

  // Save model when changed
  const handleModelChange = async (m: string) => {
    setModel(m)
    try {
      await invoke('set_model', { model: m })
    } catch (e) {
      console.error('Failed to save model:', e)
    }
  }

  const startRecording = useCallback(async () => {
    if (status === 'recording') return
    if (!apiKey) {
      setError('Please enter your OpenAI API key first')
      setStatus('error')
      invoke('play_sound', { sound: 'error' })
      return
    }

    setStatus('recording')
    setError('')
    setTranscript('')

    try {
      // Sound and tray icon handled by Rust backend
      await invoke('start_recording')
      // Register Escape key only while recording
      await invoke('register_escape_hotkey')
      
      // Poll audio level while recording
      const levelInterval = setInterval(async () => {
        try {
          const level = await invoke<number>('get_audio_level')
          setAudioLevel(level)
        } catch {
          clearInterval(levelInterval)
        }
      }, 50)

      // Store interval ID for cleanup
      ;(window as any).__levelInterval = levelInterval
    } catch (e) {
      setError(`Failed to start recording: ${e}`)
      setStatus('error')
      invoke('set_tray_status', { status: 'error' })
      invoke('play_sound', { sound: 'error' })
      
      // Reset to idle after 5 seconds
      setTimeout(() => {
        setStatus('idle')
        invoke('set_tray_status', { status: 'idle' })
      }, 5000)
    }
  }, [status, apiKey])

  const stopRecording = useCallback(async () => {
    if (status !== 'recording' && status !== 'paused') return

    // Unregister Escape key when done recording
    invoke('unregister_escape_hotkey').catch(() => {})

    // Clear level polling
    if ((window as any).__levelInterval) {
      clearInterval((window as any).__levelInterval)
    }
    setAudioLevel(0)
    setStatus('processing')

    try {
      // Stop recording and get audio path (tray shows ⏳)
      const audioPath = await invoke<string>('stop_recording')
      
      // Show processing indicator
      invoke('set_tray_status', { status: 'processing' })
      
      const result = await invoke<string>('transcribe', { 
        audioPath,
        apiKey,
        model: model || null,
        prompt: prompt || null,
      })
      
      setTranscript(result)
      
      // Copy to clipboard
      await writeText(result)
      
      // Show success indicator and play sound
      invoke('set_tray_status', { status: 'success' })
      invoke('play_sound', { sound: 'success' })
      
      // Show notification
      await sendNotification({
        title: 'Scribe',
        body: '✅ Copied to clipboard',
      })
      
      setStatus('success')
      
      // Reset to idle after 3 seconds
      setTimeout(() => {
        setStatus('idle')
        invoke('set_tray_status', { status: 'idle' })
      }, 3000)
    } catch (e) {
      setError(`${e}`)
      setStatus('error')
      invoke('set_tray_status', { status: 'error' })
      invoke('play_sound', { sound: 'error' })
      
      // Reset to idle after 5 seconds
      setTimeout(() => {
        setStatus('idle')
        invoke('set_tray_status', { status: 'idle' })
      }, 5000)
    }
  }, [status, apiKey, prompt])

  const cancelRecording = useCallback(async () => {
    if (status !== 'recording' && status !== 'paused') return

    // Unregister Escape key when done recording
    invoke('unregister_escape_hotkey').catch(() => {})

    // Clear level polling
    if ((window as any).__levelInterval) {
      clearInterval((window as any).__levelInterval)
    }
    setAudioLevel(0)

    try {
      await invoke('cancel_recording')
      setStatus('idle')
      setError('')
    } catch (e) {
      console.error('Failed to cancel:', e)
      setStatus('idle')
    }
  }, [status])

  const togglePause = useCallback(async () => {
    if (status !== 'recording' && status !== 'paused') return

    try {
      const isPaused = await invoke<boolean>('pause_recording')
      setStatus(isPaused ? 'paused' : 'recording')
      if (isPaused) {
        setAudioLevel(0)
      }
    } catch (e) {
      console.error('Failed to toggle pause:', e)
    }
  }, [status])

  // Toggle recording
  const toggleRecording = useCallback(() => {
    if (status === 'recording' || status === 'paused') {
      stopRecording()
    } else if (status === 'idle' || status === 'success' || status === 'error') {
      startRecording()
    }
  }, [status, startRecording, stopRecording])

  // Listen for toggle event from Rust backend (global shortcut)
  useEffect(() => {
    const unlisten = listen('toggle-recording', () => {
      toggleRecording()
    })

    return () => {
      unlisten.then(f => f())
    }
  }, [toggleRecording])

  // Listen for cancel event from Rust backend (Escape key)
  useEffect(() => {
    const unlisten = listen('cancel-recording', () => {
      cancelRecording()
    })

    return () => {
      unlisten.then(f => f())
    }
  }, [cancelRecording])

  const statusLabels: Record<Status, string> = {
    idle: 'Ready',
    recording: 'Recording...',
    paused: 'Paused',
    processing: 'Transcribing...',
    success: 'Copied!',
    error: 'Error',
  }

  const buttonLabels: Record<Status, string> = {
    idle: 'Start Recording',
    recording: 'Stop Recording',
    paused: 'Stop Recording',
    processing: 'Processing...',
    success: 'Start Recording',
    error: 'Try Again',
  }

  return (
    <div className="app">
      <div className="header" data-tauri-drag-region>
        <h1>🎙️ Scribe</h1>
        <span className={`status-badge ${status}`}>
          <span className={`status-dot ${status}`} />
          {statusLabels[status]}
        </span>
      </div>

      <div className="main-content">
        {(status === 'recording' || status === 'paused') && (
          <div className="audio-level">
            <div 
              className={`audio-level-bar ${status === 'paused' ? 'paused' : ''}`}
              style={{ width: status === 'paused' ? '100%' : `${audioLevel * 100}%` }} 
            />
          </div>
        )}

        <div className="button-row">
          <button
            className={`record-button ${status === 'recording' ? 'recording' : status === 'paused' ? 'paused' : 'idle'}`}
            onClick={toggleRecording}
            disabled={status === 'processing'}
          >
            <span className="mic-icon">{status === 'recording' || status === 'paused' ? '⏹️' : '🎤'}</span>
            {buttonLabels[status]}
          </button>

          {(status === 'recording' || status === 'paused') && (
            <>
              <button
                className="control-button pause-button"
                onClick={togglePause}
                title={status === 'paused' ? 'Resume' : 'Pause'}
              >
                {status === 'paused' ? '▶️' : '⏸️'}
              </button>
              <button
                className="control-button cancel-button"
                onClick={cancelRecording}
                title="Cancel (Esc)"
              >
                ✕
              </button>
            </>
          )}
        </div>

        <p className="shortcut-hint">
          {status === 'recording' || status === 'paused' 
            ? <>Press <kbd>Esc</kbd> to cancel</>
            : <>or press <kbd>⌘</kbd> + <kbd>⇧</kbd> + <kbd>Space</kbd></>
          }
        </p>

        {transcript && (
          <div className="transcript-preview">
            <p className="label">Last transcript:</p>
            <p>{transcript}</p>
          </div>
        )}

        {error && (
          <div className="error-message">
            {error}
          </div>
        )}

        <div className="settings-section">
          <h3>OpenAI API Key</h3>
          <input
            type="password"
            className="api-key-input"
            placeholder="sk-..."
            value={apiKey}
            onChange={(e) => handleApiKeyChange(e.target.value)}
          />
        </div>

        <div className="settings-section" style={{ marginTop: '12px', paddingTop: '12px' }}>
          <h3>Model</h3>
          <select
            className="api-key-input"
            value={model}
            onChange={(e) => handleModelChange(e.target.value)}
            style={{ cursor: 'pointer' }}
          >
            <option value="whisper-1">whisper-1 — $0.006/min, classic</option>
            <option value="gpt-4o-mini-transcribe">gpt-4o-mini-transcribe — $0.003/min, faster &amp; cheaper</option>
            <option value="gpt-4o-transcribe">gpt-4o-transcribe — $0.006/min, best quality</option>
          </select>
        </div>

        <div className="settings-section" style={{ marginTop: '12px', paddingTop: '12px' }}>
          <h3>Vocabulary Hints</h3>
          <textarea
            className="api-key-input"
            placeholder="Technical terms, names, acronyms..."
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            style={{ 
              minHeight: '60px', 
              resize: 'vertical',
              fontFamily: 'inherit',
              fontSize: '12px',
            }}
          />
          <p style={{ fontSize: '10px', color: '#666', marginTop: '4px' }}>
            Add terms the model should recognize correctly
          </p>
        </div>
      </div>
    </div>
  )
}

export default App
