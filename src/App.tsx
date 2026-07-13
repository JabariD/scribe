import { useState, useEffect, useCallback, useRef } from 'react'
import { invoke } from '@tauri-apps/api/tauri'
import { writeText } from '@tauri-apps/api/clipboard'
import { sendNotification } from '@tauri-apps/api/notification'
import { listen } from '@tauri-apps/api/event'
import { appWindow, LogicalPosition, LogicalSize } from '@tauri-apps/api/window'

type Status = 'idle' | 'recording' | 'paused' | 'processing' | 'success' | 'error'
type ViewMode = 'settings' | 'overlay'
type SettingsTab = 'record' | 'settings' | 'history' | 'log'
type AppLogLevel = 'info' | 'success' | 'error'

type AppLogEntry = {
  id: number
  timestamp: string
  level: AppLogLevel
  message: string
}

type TranscriptHistoryEntry = {
  id: string
  createdAt: string
  transcript: string
  model: string
  postProcessApplied: boolean
}

type TranscriptionResult = {
  transcript: string
  post_process_applied: boolean
  post_process_error: string | null
}

const DEFAULT_POST_PROCESS_PROMPT = `Clean up this voice transcript. Remove filler words like um, uh, ah, and you know. Fix punctuation, capitalization, spelling, and grammar. Preserve the speaker's meaning, wording, tone, and formatting as much as possible. Return only the cleaned transcript.`
const SETTINGS_WINDOW_SIZE = { width: 400, height: 620 }
const SETTINGS_TABS: { id: SettingsTab; label: string }[] = [
  { id: 'record', label: 'Record' },
  { id: 'settings', label: 'Settings' },
  { id: 'history', label: 'History' },
  { id: 'log', label: 'Log' },
]
const OVERLAY_WINDOW_SIZE = { width: 760, height: 190 }
const WAVEFORM_BAR_COUNT = 56
const BASE_WAVEFORM_LEVEL = 0.08
const APP_LOG_LIMIT = 60
const HISTORY_STORAGE_KEY = 'scribe.transcriptHistory'
const HISTORY_RETENTION_STORAGE_KEY = 'scribe.historyRetentionDays'
const DEFAULT_HISTORY_RETENTION_DAYS = 30
const MAX_HISTORY_ENTRIES = 200

function pruneHistory(entries: TranscriptHistoryEntry[], retentionDays: number) {
  const sortedEntries = [...entries].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))

  if (retentionDays <= 0) {
    return sortedEntries.slice(0, MAX_HISTORY_ENTRIES)
  }

  const oldestAllowed = Date.now() - retentionDays * 24 * 60 * 60 * 1000
  return sortedEntries
    .filter((entry) => Date.parse(entry.createdAt) >= oldestAllowed)
    .slice(0, MAX_HISTORY_ENTRIES)
}

function formatHistoryTimestamp(createdAt: string) {
  return new Date(createdAt).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function normalizeRetentionDays(value: number) {
  if (!Number.isFinite(value)) return DEFAULT_HISTORY_RETENTION_DAYS
  return Math.max(0, Math.min(3650, Math.round(value)))
}

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
  const [showRecordingOverlay, setShowRecordingOverlay] = useState<boolean>(true)
  const [realtimeTranscriptionEnabled, setRealtimeTranscriptionEnabled] = useState<boolean>(false)
  const [prompt, setPrompt] = useState<string>('')
  const [postProcessEnabled, setPostProcessEnabled] = useState<boolean>(false)
  const [postProcessPrompt, setPostProcessPrompt] = useState<string>(DEFAULT_POST_PROCESS_PROMPT)
  const [historyRetentionDays, setHistoryRetentionDays] = useState<number>(DEFAULT_HISTORY_RETENTION_DAYS)
  const [transcriptHistory, setTranscriptHistory] = useState<TranscriptHistoryEntry[]>([])
  const [appLogs, setAppLogs] = useState<AppLogEntry[]>([])
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('record')

  const levelIntervalRef = useRef<number | null>(null)
  const hideTimerRef = useRef<number | null>(null)
  const waveformFrameRef = useRef(0)
  const liveTranscriptionStartedRef = useRef(false)

  const addLog = useCallback((message: string, level: AppLogLevel = 'info') => {
    const now = new Date()
    const timestamp = now.toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })

    setAppLogs((currentLogs) => [
      { id: now.getTime() + Math.random(), timestamp, level, message },
      ...currentLogs,
    ].slice(0, APP_LOG_LIMIT))
  }, [])

  const saveTranscriptHistory = useCallback((nextHistory: TranscriptHistoryEntry[]) => {
    window.localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(nextHistory))
  }, [])

  const addTranscriptToHistory = useCallback((nextTranscript: string, postProcessApplied: boolean) => {
    const trimmedTranscript = nextTranscript.trim()
    if (!trimmedTranscript) return

    const entry: TranscriptHistoryEntry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      createdAt: new Date().toISOString(),
      transcript: trimmedTranscript,
      model,
      postProcessApplied,
    }

    setTranscriptHistory((currentHistory) => {
      const nextHistory = pruneHistory([entry, ...currentHistory], historyRetentionDays)
      saveTranscriptHistory(nextHistory)
      return nextHistory
    })
  }, [historyRetentionDays, model, saveTranscriptHistory])

  const handleHistoryRetentionChange = useCallback((value: number) => {
    const nextRetentionDays = normalizeRetentionDays(value)
    setHistoryRetentionDays(nextRetentionDays)
    window.localStorage.setItem(HISTORY_RETENTION_STORAGE_KEY, String(nextRetentionDays))

    setTranscriptHistory((currentHistory) => {
      const nextHistory = pruneHistory(currentHistory, nextRetentionDays)
      saveTranscriptHistory(nextHistory)
      return nextHistory
    })
  }, [saveTranscriptHistory])

  const clearHistory = useCallback(() => {
    setTranscriptHistory([])
    saveTranscriptHistory([])
    addLog('Transcript history cleared')
  }, [addLog, saveTranscriptHistory])

  const copyHistoryEntry = useCallback(async (entry: TranscriptHistoryEntry) => {
    await writeText(entry.transcript)
    addLog('History transcript copied to clipboard', 'success')
  }, [addLog])

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

    const availableHeight = window.screen.availHeight || SETTINGS_WINDOW_SIZE.height
    const height = Math.min(SETTINGS_WINDOW_SIZE.height, Math.max(560, availableHeight - 56))

    await appWindow.setAlwaysOnTop(false)
    await appWindow.setSize(new LogicalSize(SETTINGS_WINDOW_SIZE.width, height))
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
    addLog('Scribe ready')

    const savedRetentionDays = normalizeRetentionDays(Number(window.localStorage.getItem(HISTORY_RETENTION_STORAGE_KEY) ?? DEFAULT_HISTORY_RETENTION_DAYS))
    const savedHistory = window.localStorage.getItem(HISTORY_STORAGE_KEY)
    setHistoryRetentionDays(savedRetentionDays)

    if (savedHistory) {
      try {
        const parsedHistory = JSON.parse(savedHistory) as TranscriptHistoryEntry[]
        const nextHistory = pruneHistory(parsedHistory, savedRetentionDays)
        setTranscriptHistory(nextHistory)
        saveTranscriptHistory(nextHistory)
      } catch {
        setTranscriptHistory([])
        saveTranscriptHistory([])
      }
    }

    invoke<string>('get_api_key').then((key) => {
      if (key) setApiKey(key)
    }).catch(() => {})

    invoke<string>('get_model').then((savedModel) => {
      if (savedModel) setModel(savedModel)
    }).catch(() => {})

    invoke<boolean>('get_show_recording_overlay').then((savedPreference) => {
      setShowRecordingOverlay(savedPreference)
    }).catch(() => {})

    invoke<boolean>('get_realtime_transcription_enabled').then((savedPreference) => {
      setRealtimeTranscriptionEnabled(savedPreference)
    }).catch(() => {})

    invoke<string>('get_prompt').then((savedPrompt) => {
      setPrompt(savedPrompt)
    }).catch(() => {})

    invoke<boolean>('get_post_process_enabled').then((savedPreference) => {
      setPostProcessEnabled(savedPreference)
    }).catch(() => {})

    invoke<string>('get_post_process_prompt').then((savedPrompt) => {
      if (savedPrompt) setPostProcessPrompt(savedPrompt)
    }).catch(() => {})
  }, [addLog, saveTranscriptHistory])

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

  const handleShowRecordingOverlayChange = async (enabled: boolean) => {
    setShowRecordingOverlay(enabled)
    try {
      await invoke('set_show_recording_overlay', { showRecordingOverlay: enabled })
    } catch (saveError) {
      console.error('Failed to save overlay preference:', saveError)
    }
  }

  const handleRealtimeTranscriptionChange = async (enabled: boolean) => {
    setRealtimeTranscriptionEnabled(enabled)
    addLog(enabled ? 'Realtime transcription enabled' : 'Realtime transcription disabled')
    try {
      await invoke('set_realtime_transcription_enabled', { realtimeTranscriptionEnabled: enabled })
    } catch (saveError) {
      console.error('Failed to save realtime transcription preference:', saveError)
    }
  }

  const handlePromptChange = async (nextPrompt: string) => {
    setPrompt(nextPrompt)
    try {
      await invoke('set_prompt', { prompt: nextPrompt })
    } catch (saveError) {
      console.error('Failed to save vocabulary hints:', saveError)
    }
  }

  const handlePostProcessEnabledChange = async (enabled: boolean) => {
    setPostProcessEnabled(enabled)
    addLog(enabled ? 'Post-processing enabled' : 'Post-processing disabled')
    try {
      await invoke('set_post_process_enabled', { postProcessEnabled: enabled })
    } catch (saveError) {
      console.error('Failed to save post-processing preference:', saveError)
    }
  }

  const handlePostProcessPromptChange = async (nextPrompt: string) => {
    setPostProcessPrompt(nextPrompt)
    try {
      await invoke('set_post_process_prompt', { postProcessPrompt: nextPrompt })
    } catch (saveError) {
      console.error('Failed to save post-processing prompt:', saveError)
    }
  }

  const startRecording = useCallback(async () => {
    if (status === 'recording') return

    clearHideTimer()

    if (!apiKey) {
      setError('Please enter your OpenAI API key first')
      setStatus('error')
      addLog('Missing OpenAI API key', 'error')
      setSettingsTab('settings')
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
      liveTranscriptionStartedRef.current = false
      if (realtimeTranscriptionEnabled) {
        try {
          await invoke('start_live_transcription', {
            apiKey,
            model,
            prompt,
          })
          liveTranscriptionStartedRef.current = true
          addLog(model === 'whisper-1'
            ? 'Realtime transcription started with gpt-4o-mini-transcribe'
            : `Realtime transcription started with ${model}`)
        } catch (liveError) {
          addLog(`Realtime unavailable; using standard transcription: ${liveError}`, 'error')
        }
      }
      await invoke('register_escape_hotkey')
      setStatus('recording')
      addLog('Recording started')
      if (showRecordingOverlay) {
        await showOverlayWindow()
      } else {
        await hideWindow()
      }
      startAudioPolling()
    } catch (recordingError) {
      const message = `Failed to start recording: ${recordingError}`
      setError(message)
      setStatus('error')
      addLog(message, 'error')
      if (shouldShowSettingsForError(message)) setSettingsTab('settings')
      invoke('set_tray_status', { status: 'error' }).catch(() => {})
      invoke('play_sound', { sound: 'error' }).catch(() => {})
      await showSettingsWindow()
    }
  }, [addLog, apiKey, clearHideTimer, hideWindow, model, prompt, realtimeTranscriptionEnabled, resetWaveform, showOverlayWindow, showRecordingOverlay, showSettingsWindow, startAudioPolling, status])

  const stopRecording = useCallback(async () => {
    if (!isRecordingStatus(status)) return

    clearHideTimer()
    invoke('unregister_escape_hotkey').catch(() => {})
    clearLevelPolling()
    setAudioLevel(0)
    setStatus('processing')

    try {
      if (showRecordingOverlay) {
        await showOverlayWindow()
      }

      const audioPath = await invoke<string>('stop_recording')
      await invoke('set_tray_status', { status: 'processing' })
      addLog(postProcessEnabled ? 'Finishing transcript with post-processing' : 'Finishing transcript')

      let result: TranscriptionResult
      if (liveTranscriptionStartedRef.current) {
        try {
          const liveTranscript = await invoke<string>('finish_live_transcription')
          result = await invoke<TranscriptionResult>('finalize_live_transcript', {
            transcript: liveTranscript,
            apiKey,
            postProcessEnabled,
            postProcessPrompt: postProcessPrompt || null,
          })
          addLog('Realtime transcript completed')
        } catch (liveError) {
          addLog(`Realtime transcription failed; retrying from saved audio: ${liveError}`, 'error')
          result = await invoke<TranscriptionResult>('transcribe', {
            audioPath,
            apiKey,
            model: model || null,
            prompt: prompt || null,
            postProcessEnabled,
            postProcessPrompt: postProcessPrompt || null,
          })
        } finally {
          liveTranscriptionStartedRef.current = false
        }
      } else {
        result = await invoke<TranscriptionResult>('transcribe', {
          audioPath,
          apiKey,
          model: model || null,
          prompt: prompt || null,
          postProcessEnabled,
          postProcessPrompt: postProcessPrompt || null,
        })
      }

      if (result.post_process_error) {
        addLog(`Post-processing skipped: ${result.post_process_error}`, 'error')
      }

      setTranscript(result.transcript)
      addTranscriptToHistory(result.transcript, result.post_process_applied)
      await writeText(result.transcript)
      await invoke('set_tray_status', { status: 'success' })
      addLog(result.post_process_applied ? 'Cleaned transcript copied to clipboard' : 'Transcript copied to clipboard', 'success')
      invoke('play_sound', { sound: 'success' }).catch(() => {})

      await sendNotification({
        title: 'Scribe',
        body: 'Copied to clipboard',
      })

      setStatus('success')
      scheduleHide(1800)
    } catch (stopError) {
      if (liveTranscriptionStartedRef.current) {
        invoke('cancel_live_transcription').catch(() => {})
        liveTranscriptionStartedRef.current = false
      }
      const message = `${stopError}`
      setError(message)
      setStatus('error')
      addLog(message, 'error')
      await invoke('set_tray_status', { status: 'error' })
      invoke('play_sound', { sound: 'error' }).catch(() => {})

      if (shouldShowSettingsForError(message)) {
        setSettingsTab('settings')
        await showSettingsWindow()
      } else if (showRecordingOverlay) {
        await showOverlayWindow()
        scheduleHide(5000)
      } else {
        await sendNotification({
          title: 'Scribe',
          body: message,
        })
        scheduleHide(5000)
      }
    }
  }, [addLog, addTranscriptToHistory, apiKey, clearHideTimer, clearLevelPolling, model, postProcessEnabled, postProcessPrompt, prompt, scheduleHide, showOverlayWindow, showRecordingOverlay, showSettingsWindow, status])

  const cancelRecording = useCallback(async () => {
    if (!isRecordingStatus(status)) return

    clearHideTimer()
    invoke('unregister_escape_hotkey').catch(() => {})
    clearLevelPolling()
    setAudioLevel(0)
    resetWaveform()

    if (liveTranscriptionStartedRef.current) {
      invoke('cancel_live_transcription').catch(() => {})
      liveTranscriptionStartedRef.current = false
    }

    try {
      await invoke('cancel_recording')
    } catch (cancelError) {
      console.error('Failed to cancel recording:', cancelError)
    }

    setError('')
    setStatus('idle')
    setViewMode('settings')
    addLog('Recording canceled')
    await hideWindow()
  }, [addLog, clearHideTimer, clearLevelPolling, hideWindow, resetWaveform, status])

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

  useEffect(() => {
    const unlisten = listen('recording-time-limit-reached', () => {
      stopRecording()
    })

    return () => {
      unlisten.then((dispose) => dispose())
    }
  }, [stopRecording])

  useEffect(() => {
    if (showRecordingOverlay || viewMode !== 'overlay' || status === 'error') return

    hideWindow().catch((windowError) => {
      console.error('Failed to hide overlay window:', windowError)
    })
  }, [hideWindow, showRecordingOverlay, status, viewMode])

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
      <div className="settings-shell">
        <header className="titlebar" data-tauri-drag-region>
          <div className="titlebar-row">
            <span className="app-name">Scribe</span>
            <span className={`status-chip ${status}`} aria-live="polite">
              <span className={`status-dot ${status}`} />
              {statusLabels[status]}
            </span>
          </div>

          <div className="tab-bar" role="tablist" aria-label="Scribe sections">
            {SETTINGS_TABS.map((tab) => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={settingsTab === tab.id}
                className={`tab-button ${settingsTab === tab.id ? 'active' : ''}`}
                onClick={() => setSettingsTab(tab.id)}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </header>

        {error && <div className="error-banner" role="alert">{error}</div>}

        <main className="panel" role="tabpanel">
          {settingsTab === 'record' && (
            <div className="panel-stack">
              <section className="hero" aria-labelledby="recorder-heading">
                <div className="hero-head">
                  <h2 id="recorder-heading">Recorder</h2>
                  <span className="hint"><kbd>⌘</kbd><kbd>⇧</kbd><kbd>Space</kbd></span>
                </div>

                {isRecordingStatus(status) && (
                  <div className="audio-level" aria-hidden="true">
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
                    <span className="mic-icon" aria-hidden="true">{isRecordingStatus(status) ? '⏹' : '●'}</span>
                    {buttonLabels[status]}
                  </button>

                  {isRecordingStatus(status) && (
                    <>
                      <button
                        className="control-button"
                        onClick={togglePause}
                        title={status === 'paused' ? 'Resume' : 'Pause'}
                        aria-label={status === 'paused' ? 'Resume recording' : 'Pause recording'}
                      >
                        {status === 'paused' ? '▶' : '❚❚'}
                      </button>
                      <button
                        className="control-button danger"
                        onClick={cancelRecording}
                        title="Cancel (Esc)"
                        aria-label="Cancel recording"
                      >
                        ✕
                      </button>
                    </>
                  )}
                </div>

                <p className="hero-copy">
                  {isRecordingStatus(status)
                    ? <>Press <kbd>Esc</kbd> to cancel.</>
                    : postProcessEnabled
                      ? 'Post-processing is on — transcripts are cleaned before copying.'
                      : 'Transcripts copy to your clipboard as-is.'}
                </p>
              </section>

              {transcript && (
                <section className="panel-block" aria-labelledby="last-transcript-heading">
                  <h2 id="last-transcript-heading">Last transcript</h2>
                  <p className="body-copy">{transcript}</p>
                </section>
              )}
            </div>
          )}

          {settingsTab === 'settings' && (
            <div className="panel-stack">
              <section className="panel-block" aria-labelledby="transcription-heading">
                <h2 id="transcription-heading">Transcription</h2>

                <label className="field-label" htmlFor="api-key">OpenAI API key</label>
                <input
                  id="api-key"
                  type="password"
                  className="field-input mono"
                  placeholder="sk-..."
                  value={apiKey}
                  onChange={(event) => handleApiKeyChange(event.target.value)}
                />

                <label className="field-label" htmlFor="transcription-model">Audio model</label>
                <select
                  id="transcription-model"
                  className="field-input"
                  value={model}
                  onChange={(event) => handleModelChange(event.target.value)}
                >
                  <option value="whisper-1">whisper-1 — classic</option>
                  <option value="gpt-4o-mini-transcribe">gpt-4o-mini-transcribe — faster, lower cost</option>
                  <option value="gpt-4o-transcribe">gpt-4o-transcribe — best quality</option>
                </select>
              </section>

              <section className="panel-block" aria-labelledby="behavior-heading">
                <h2 id="behavior-heading">Behavior</h2>
                <label className="checkbox-setting">
                  <input
                    type="checkbox"
                    checked={showRecordingOverlay}
                    onChange={(event) => handleShowRecordingOverlayChange(event.target.checked)}
                  />
                  <span>
                    <strong>Show recording HUD</strong>
                    <small>When off, dictation stays minimized unless Scribe needs your attention.</small>
                  </span>
                </label>

                <label className="checkbox-setting">
                  <input
                    type="checkbox"
                    checked={realtimeTranscriptionEnabled}
                    onChange={(event) => handleRealtimeTranscriptionChange(event.target.checked)}
                  />
                  <span>
                    <strong>Transcribe while recording</strong>
                    <small>Reduces the wait after stopping. whisper-1 uses gpt-4o-mini-transcribe in this mode.</small>
                  </span>
                </label>
              </section>

              <section className="panel-block" aria-labelledby="cleanup-heading">
                <div className="panel-block-head">
                  <h2 id="cleanup-heading">Post-processing</h2>
                  <span className={`status-text ${postProcessEnabled ? 'on' : ''}`}>{postProcessEnabled ? 'On' : 'Off'}</span>
                </div>
                <p className="body-hint">Optional cleanup pass with gpt-4o-mini before copying.</p>

                <label className="checkbox-setting">
                  <input
                    type="checkbox"
                    checked={postProcessEnabled}
                    onChange={(event) => handlePostProcessEnabledChange(event.target.checked)}
                  />
                  <span>
                    <strong>Clean transcript before copying</strong>
                    <small>Removes filler words and fixes punctuation, spelling, and grammar.</small>
                  </span>
                </label>

                <label className="field-label" htmlFor="post-process-prompt">Cleanup prompt</label>
                <textarea
                  id="post-process-prompt"
                  className="field-input mono textarea"
                  value={postProcessPrompt}
                  onChange={(event) => handlePostProcessPromptChange(event.target.value)}
                />
                <button
                  type="button"
                  className="text-button"
                  onClick={() => handlePostProcessPromptChange(DEFAULT_POST_PROCESS_PROMPT)}
                >
                  Reset to default prompt
                </button>
              </section>

              <section className="panel-block" aria-labelledby="vocabulary-heading">
                <h2 id="vocabulary-heading">Vocabulary hints</h2>
                <p className="body-hint">Terms the transcription model should recognize correctly.</p>
                <textarea
                  className="field-input mono textarea"
                  placeholder="Technical terms, names, acronyms..."
                  value={prompt}
                  onChange={(event) => handlePromptChange(event.target.value)}
                />
              </section>
            </div>
          )}

          {settingsTab === 'history' && (
            <div className="panel-stack">
              <section className="panel-block" aria-labelledby="history-heading">
                <div className="panel-block-head">
                  <h2 id="history-heading">History</h2>
                  <button type="button" className="text-button" onClick={clearHistory} disabled={transcriptHistory.length === 0}>
                    Clear
                  </button>
                </div>
                <p className="body-hint">Previous transcriptions, stored locally on this Mac.</p>

                <label className="field-label" htmlFor="history-retention-days">Expire after (days)</label>
                <div className="inline-field">
                  <input
                    id="history-retention-days"
                    type="number"
                    min="0"
                    max="3650"
                    className="field-input number"
                    value={historyRetentionDays}
                    onChange={(event) => handleHistoryRetentionChange(Number(event.target.value))}
                  />
                  <span className="body-hint">0 = never expire</span>
                </div>

                {transcriptHistory.length === 0 ? (
                  <p className="empty-state">No saved transcriptions yet.</p>
                ) : (
                  <ol className="entry-list">
                    {transcriptHistory.map((entry) => (
                      <li key={entry.id} className="entry-row">
                        <div className="entry-meta">
                          <time>{formatHistoryTimestamp(entry.createdAt)}</time>
                          <span>{entry.model}</span>
                          {entry.postProcessApplied && <span>cleaned</span>}
                        </div>
                        <p>{entry.transcript}</p>
                        <button type="button" className="text-button" onClick={() => copyHistoryEntry(entry)}>
                          Copy
                        </button>
                      </li>
                    ))}
                  </ol>
                )}
              </section>
            </div>
          )}

          {settingsTab === 'log' && (
            <div className="panel-stack">
              <section className="panel-block" aria-labelledby="log-heading">
                <div className="panel-block-head">
                  <h2 id="log-heading">App log</h2>
                  <button type="button" className="text-button" onClick={() => setAppLogs([])} disabled={appLogs.length === 0}>
                    Clear
                  </button>
                </div>
                <p className="body-hint">Recent local activity for debugging.</p>

                {appLogs.length === 0 ? (
                  <p className="empty-state">No log entries yet.</p>
                ) : (
                  <ol className="log-list" aria-live="polite">
                    {appLogs.map((entry) => (
                      <li key={entry.id} className={`log-row ${entry.level}`}>
                        <time>{entry.timestamp}</time>
                        <span>{entry.message}</span>
                      </li>
                    ))}
                  </ol>
                )}
              </section>
            </div>
          )}
        </main>
      </div>
    </div>
  )

  return showRecordingOverlay && viewMode === 'overlay' && status !== 'idle' ? renderOverlay() : renderSettings()
}

export default App
