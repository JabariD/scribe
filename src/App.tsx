import { useState, useEffect, useCallback, useRef } from 'react'
import { invoke } from '@tauri-apps/api/tauri'
import { writeText } from '@tauri-apps/api/clipboard'
import { sendNotification } from '@tauri-apps/api/notification'
import { listen } from '@tauri-apps/api/event'
import { appWindow, LogicalPosition, LogicalSize } from '@tauri-apps/api/window'

type Status = 'idle' | 'recording' | 'paused' | 'processing' | 'success' | 'error'
type ViewMode = 'settings' | 'overlay'

const DEFAULT_PROMPT = `Technical terms: TypeScript, JavaScript, React, useState, useEffect, async, await, API, JSON, npm, git, GitHub, VS Code, macOS, iOS, Android`
const SETTINGS_WINDOW_SIZE = { width: 320, height: 520 }
const OVERLAY_WINDOW_SIZE = { width: 760, height: 190 }
const WAVEFORM_BAR_COUNT = 56
const BASE_WAVEFORM_LEVEL = 0.08

function normalizeAudioLevel(level: number) {
  return Math.min(1, Math.pow(Math.max(level, 0) * 24, 0.6))
}

function createWaveform(level = 0, frame = 0) {
  const normalized = normalizeAudioLevel(level)
  const center = (WAVEFORM_BAR_COUNT - 1) / 2

  return Array.from({ length: WAVEFORM_BAR_COUNT }, (_, index) => {
    const distanceFromCenter = Math.abs(index - center) / center
    const envelope = Math.pow(1 - distanceFromCenter, 1.35)
    const primaryPulse = (Math.sin(frame * 0.55 + index * 0.72) + 1) / 2
    const secondaryPulse = (Math.sin(frame * 0.24 + index * 0.31 + 1.4) + 1) / 2
    const shimmer = primaryPulse * 0.7 + secondaryPulse * 0.3
    const levelWithEnvelope = normalized * (0.22 + envelope * 0.78)
    const animatedLevel = levelWithEnvelope * (0.35 + shimmer * 0.65)

    return Math.min(1, BASE_WAVEFORM_LEVEL + animatedLevel)
  })
}

function isRecordingStatus(status: Status) {
  return status === 'recording' || status === 'paused'
}

function shouldShowSettingsForError(message: string) {
  const normalized = message.toLowerCase()
  return (
    normalized.includes('api key') ||
    normalized.includes('microphone') ||
    normalized.includes('permission') ||
    normalized.includes('no audio detected')
  )
}

function ShortcutKeys({ keys }: { keys: string[] }) {
  return (
    <span className="shortcut-group" aria-hidden="true">
      {keys.map((key) => (
        <kbd key={key}>{key}</kbd>
      ))}
    </span>
  )
}

function App() {
  const [status, setStatus] = useState<Status>('idle')
  const [viewMode, setViewMode] = useState<ViewMode>('settings')
  const [transcript, setTranscript] = useState<string>('')
  const [error, setError] = useState<string>('')
  const [audioLevel, setAudioLevel] = useState<number>(0)
  const [waveform, setWaveform] = useState<number[]>(() => createWaveform(0))
  const [apiKey, setApiKey] = useState<string>('')
  const [model, setModel] = useState<string>('whisper-1')
  const [prompt, setPrompt] = useState<string>(DEFAULT_PROMPT)

  const levelIntervalRef = useRef<number | null>(null)
  const hideTimerRef = useRef<number | null>(null)
  const waveformFrameRef = useRef(0)

  const clearLevelPolling = useCallback(() => {
    if (levelIntervalRef.current !== null) {
      window.clearInterval(levelIntervalRef.current)
      levelIntervalRef.current = null
    }
  }, [])

  const clearHideTimer = useCallback(() => {
    if (hideTimerRef.current !== null) {
      window.clearTimeout(hideTimerRef.current)
      hideTimerRef.current = null
    }
  }, [])

  const resetWaveform = useCallback((level = 0) => {
    waveformFrameRef.current = 0
    setWaveform(createWaveform(level, waveformFrameRef.current))
  }, [])

  const pushWaveformLevel = useCallback((level: number) => {
    waveformFrameRef.current += 1
    setWaveform(createWaveform(level, waveformFrameRef.current))
  }, [])

  const hideWindow = useCallback(async () => {
    await appWindow.setAlwaysOnTop(false)
    await appWindow.hide()
  }, [])

  const showOverlayWindow = useCallback(async () => {
    setViewMode('overlay')

    const screenWidth = window.screen.availWidth || window.screen.width || OVERLAY_WINDOW_SIZE.width
    const screenTop = (window.screen as Screen & { availTop?: number }).availTop ?? 0
    const x = Math.max(0, Math.round((screenWidth - OVERLAY_WINDOW_SIZE.width) / 2))
    const y = Math.max(24, screenTop + 24)

    await appWindow.setSize(new LogicalSize(OVERLAY_WINDOW_SIZE.width, OVERLAY_WINDOW_SIZE.height))
    await appWindow.setPosition(new LogicalPosition(x, y))
    await appWindow.setAlwaysOnTop(true)
    await appWindow.show()
  }, [])

  const showSettingsWindow = useCallback(async () => {
    clearHideTimer()
    setViewMode('settings')

    await appWindow.setAlwaysOnTop(false)
    await appWindow.setSize(new LogicalSize(SETTINGS_WINDOW_SIZE.width, SETTINGS_WINDOW_SIZE.height))
    await appWindow.center()
    await appWindow.show()
    await appWindow.setFocus()
  }, [clearHideTimer])

  const returnToIdleAndHide = useCallback(async () => {
    clearHideTimer()
    clearLevelPolling()
    setStatus('idle')
    setViewMode('settings')
    setAudioLevel(0)
    resetWaveform()
    await invoke('set_tray_status', { status: 'idle' })
    await hideWindow()
  }, [clearHideTimer, clearLevelPolling, hideWindow, resetWaveform])

  const scheduleHide = useCallback((delayMs: number) => {
    clearHideTimer()
    hideTimerRef.current = window.setTimeout(() => {
      returnToIdleAndHide().catch((hideError) => {
        console.error('Failed to hide window:', hideError)
      })
    }, delayMs)
  }, [clearHideTimer, returnToIdleAndHide])

  const startAudioPolling = useCallback(() => {
    clearLevelPolling()

    levelIntervalRef.current = window.setInterval(async () => {
      try {
        const level = await invoke<number>('get_audio_level')
        setAudioLevel(level)
        pushWaveformLevel(level)
      } catch {
        clearLevelPolling()
      }
    }, 50)
  }, [clearLevelPolling, pushWaveformLevel])

  useEffect(() => {
    invoke<string>('get_api_key').then((key) => {
      if (key) setApiKey(key)
    }).catch(() => {})

    invoke<string>('get_model').then((savedModel) => {
      if (savedModel) setModel(savedModel)
    }).catch(() => {})
  }, [])

  useEffect(() => {
    return () => {
      clearLevelPolling()
      clearHideTimer()
    }
  }, [clearHideTimer, clearLevelPolling])

  const handleApiKeyChange = async (key: string) => {
    setApiKey(key)
    try {
      await invoke('set_api_key', { apiKey: key })
    } catch (saveError) {
      console.error('Failed to save API key:', saveError)
    }
  }

  const handleModelChange = async (nextModel: string) => {
    setModel(nextModel)
    try {
      await invoke('set_model', { model: nextModel })
    } catch (saveError) {
      console.error('Failed to save model:', saveError)
    }
  }

  const startRecording = useCallback(async () => {
    if (status === 'recording') return

    clearHideTimer()

    if (!apiKey) {
      setError('Please enter your OpenAI API key first')
      setStatus('error')
      await showSettingsWindow()
      invoke('play_sound', { sound: 'error' }).catch(() => {})
      return
    }

    setError('')
    setTranscript('')
    setAudioLevel(0)
    resetWaveform()

    try {
      await invoke('start_recording')
      await invoke('register_escape_hotkey')
      setStatus('recording')
      await showOverlayWindow()
      startAudioPolling()
    } catch (recordingError) {
      const message = `Failed to start recording: ${recordingError}`
      setError(message)
      setStatus('error')
      invoke('set_tray_status', { status: 'error' }).catch(() => {})
      invoke('play_sound', { sound: 'error' }).catch(() => {})
      await showSettingsWindow()
    }
  }, [apiKey, clearHideTimer, resetWaveform, showOverlayWindow, showSettingsWindow, startAudioPolling, status])

  const stopRecording = useCallback(async () => {
    if (!isRecordingStatus(status)) return

    clearHideTimer()
    invoke('unregister_escape_hotkey').catch(() => {})
    clearLevelPolling()
    setAudioLevel(0)
    setStatus('processing')

    try {
      await showOverlayWindow()

      const audioPath = await invoke<string>('stop_recording')
      await invoke('set_tray_status', { status: 'processing' })

      const result = await invoke<string>('transcribe', {
        audioPath,
        apiKey,
        model: model || null,
        prompt: prompt || null,
      })

      setTranscript(result)
      await writeText(result)
      await invoke('set_tray_status', { status: 'success' })
      invoke('play_sound', { sound: 'success' }).catch(() => {})

      await sendNotification({
        title: 'Scribe',
        body: 'Copied to clipboard',
      })

      setStatus('success')
      scheduleHide(1800)
    } catch (stopError) {
      const message = `${stopError}`
      setError(message)
      setStatus('error')
      await invoke('set_tray_status', { status: 'error' })
      invoke('play_sound', { sound: 'error' }).catch(() => {})

      if (shouldShowSettingsForError(message)) {
        await showSettingsWindow()
      } else {
        await showOverlayWindow()
        scheduleHide(5000)
      }
    }
  }, [apiKey, clearHideTimer, clearLevelPolling, model, prompt, scheduleHide, showOverlayWindow, showSettingsWindow, status])

  const cancelRecording = useCallback(async () => {
    if (!isRecordingStatus(status)) return

    clearHideTimer()
    invoke('unregister_escape_hotkey').catch(() => {})
    clearLevelPolling()
    setAudioLevel(0)
    resetWaveform()

    try {
      await invoke('cancel_recording')
    } catch (cancelError) {
      console.error('Failed to cancel recording:', cancelError)
    }

    setError('')
    setStatus('idle')
    setViewMode('settings')
    await hideWindow()
  }, [clearHideTimer, clearLevelPolling, hideWindow, resetWaveform, status])

  const togglePause = useCallback(async () => {
    if (!isRecordingStatus(status)) return

    try {
      const paused = await invoke<boolean>('pause_recording')
      setStatus(paused ? 'paused' : 'recording')
      if (paused) {
        setAudioLevel(0)
        resetWaveform(0)
      }
    } catch (pauseError) {
      console.error('Failed to toggle pause:', pauseError)
    }
  }, [resetWaveform, status])

  const toggleRecording = useCallback(() => {
    if (isRecordingStatus(status)) {
      stopRecording()
    } else if (status === 'idle' || status === 'success' || status === 'error') {
      startRecording()
    }
  }, [startRecording, status, stopRecording])

  useEffect(() => {
    const unlisten = listen('toggle-recording', () => {
      toggleRecording()
    })

    return () => {
      unlisten.then((dispose) => dispose())
    }
  }, [toggleRecording])

  useEffect(() => {
    const unlisten = listen('cancel-recording', () => {
      cancelRecording()
    })

    return () => {
      unlisten.then((dispose) => dispose())
    }
  }, [cancelRecording])

  useEffect(() => {
    const unlisten = listen('show-settings', () => {
      showSettingsWindow()
    })

    return () => {
      unlisten.then((dispose) => dispose())
    }
  }, [showSettingsWindow])

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

  const overlayStatusText: Record<Exclude<Status, 'idle'>, string> = {
    recording: 'Recording',
    paused: 'Paused',
    processing: 'Transcribing…',
    success: 'Copied to clipboard',
    error: 'Something went wrong',
  }

  const renderOverlay = () => {
    const overlayState = status === 'idle' ? 'recording' : status

    return (
      <div className={`app overlay ${overlayState}`}>
        <div className={`overlay-card ${overlayState}`}>
          <div className={`overlay-waveform ${overlayState}`} data-tauri-drag-region>
            {waveform.map((level, index) => (
              <span
                key={index}
                className="waveform-bar"
                style={{ height: `${Math.max(8, Math.round(level * 56))}px` }}
              />
            ))}
          </div>

          <div className="overlay-footer">
            <div className="overlay-status" data-tauri-drag-region>
              <span className={`overlay-status-dot ${overlayState}`} />
              <span className="overlay-status-text">
                {overlayStatusText[overlayState as Exclude<Status, 'idle'>]}
              </span>
            </div>

            <div className="overlay-actions">
              {isRecordingStatus(status) && (
                <>
                  <button className="overlay-action primary" onClick={stopRecording}>
                    <span>Stop</span>
                    <ShortcutKeys keys={['⌘', '⇧', 'Space']} />
                  </button>

                  <button
                    className="overlay-icon-action"
                    onClick={togglePause}
                    title={status === 'paused' ? 'Resume' : 'Pause'}
                  >
                    {status === 'paused' ? '▶' : '❚❚'}
                  </button>

                  <button className="overlay-action" onClick={cancelRecording}>
                    <span>Cancel</span>
                    <ShortcutKeys keys={['Esc']} />
                  </button>
                </>
              )}

              {status === 'processing' && (
                <div className="overlay-message">Working on the transcript…</div>
              )}

              {status === 'success' && (
                <div className="overlay-message success">Ready to paste</div>
              )}

              {status === 'error' && (
                <div className="overlay-message error">{error}</div>
              )}
            </div>
          </div>
        </div>
      </div>
    )
  }

  const renderSettings = () => (
    <div className="app settings">
      <div className="header" data-tauri-drag-region>
        <h1>🎙️ Scribe</h1>
        <span className={`status-badge ${status}`}>
          <span className={`status-dot ${status}`} />
          {statusLabels[status]}
        </span>
      </div>

      <div className="main-content">
        {isRecordingStatus(status) && (
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
            <span className="mic-icon">{isRecordingStatus(status) ? '⏹️' : '🎤'}</span>
            {buttonLabels[status]}
          </button>

          {isRecordingStatus(status) && (
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
          {isRecordingStatus(status)
            ? <>Press <kbd>Esc</kbd> to cancel</>
            : <>or press <kbd>⌘</kbd> + <kbd>⇧</kbd> + <kbd>Space</kbd></>}
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
            onChange={(event) => handleApiKeyChange(event.target.value)}
          />
        </div>

        <div className="settings-section compact-top-gap">
          <h3>Model</h3>
          <select
            className="api-key-input"
            value={model}
            onChange={(event) => handleModelChange(event.target.value)}
            style={{ cursor: 'pointer' }}
          >
            <option value="whisper-1">whisper-1 — $0.006/min, classic</option>
            <option value="gpt-4o-mini-transcribe">gpt-4o-mini-transcribe — $0.003/min, faster &amp; cheaper</option>
            <option value="gpt-4o-transcribe">gpt-4o-transcribe — $0.006/min, best quality</option>
          </select>
        </div>

        <div className="settings-section compact-top-gap">
          <h3>Vocabulary Hints</h3>
          <textarea
            className="api-key-input vocabulary-input"
            placeholder="Technical terms, names, acronyms..."
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
          />
          <p className="settings-note">Add terms the model should recognize correctly</p>
        </div>
      </div>
    </div>
  )

  return viewMode === 'overlay' && status !== 'idle' ? renderOverlay() : renderSettings()
}

export default App
