import { useState, useEffect, useCallback, useRef, type MutableRefObject } from 'react'
import { invoke } from '@tauri-apps/api/tauri'
import { writeText } from '@tauri-apps/api/clipboard'
import { sendNotification } from '@tauri-apps/api/notification'
import { listen } from '@tauri-apps/api/event'
import { appWindow, LogicalPosition, LogicalSize } from '@tauri-apps/api/window'

type Status = 'idle' | 'recording' | 'paused' | 'processing' | 'success' | 'error'
type ViewMode = 'settings' | 'overlay'
// 'starting' covers the moment between the hotkey and the microphone opening.
type OverlayState = 'starting' | Exclude<Status, 'idle'>
type SettingsTab = 'record' | 'settings' | 'history' | 'log'
type AppLogLevel = 'info' | 'success' | 'error'
type TranscriptionProvider = 'openai' | 'local'

type Settings = {
  api_key: string
  show_recording_overlay: boolean
  realtime_transcription_enabled: boolean
  prompt: string
  post_process_enabled: boolean
  post_process_prompt: string
  transcription_provider: TranscriptionProvider
}

type LocalModelStatus = {
  name: string
  installed: boolean
  downloading: boolean
  total_bytes: number
}

type DownloadProgress = {
  downloaded_bytes: number
  total_bytes: number
}

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

type RecordingPruneResult = {
  deleted_count: number
  freed_bytes: number
  failed_count: number
}

const DEFAULT_POST_PROCESS_PROMPT = `Clean up this voice transcript. Remove filler words like um, uh, ah, and you know. Fix punctuation, capitalization, spelling, and grammar. Preserve the speaker's meaning, wording, tone, and formatting as much as possible. Return only the cleaned transcript.`
const SETTINGS_WINDOW_SIZE = { width: 400, height: 620 }
const SETTINGS_TABS: { id: SettingsTab; label: string }[] = [
  { id: 'record', label: 'Record' },
  { id: 'settings', label: 'Settings' },
  { id: 'history', label: 'History' },
  { id: 'log', label: 'Log' },
]
// The pill plus room for its shadow inside the transparent window.
const OVERLAY_WINDOW_SIZE = { width: 380, height: 92 }
const OVERLAY_EXIT_MS = 170
const SUCCESS_HIDE_DELAY_MS = 1100
const WAVEFORM_BAR_COUNT = 23
const WAVEFORM_MAX_HEIGHT = 24
const WAVEFORM_MIN_HEIGHT = 3
const APP_LOG_LIMIT = 60
const HISTORY_STORAGE_KEY = 'scribe.transcriptHistory'
const HISTORY_RETENTION_STORAGE_KEY = 'scribe.historyRetentionDays'
const DEFAULT_HISTORY_RETENTION_DAYS = 30
const MAX_HISTORY_ENTRIES = 200
const FILE_TRANSCRIPTION_MODEL = 'gpt-transcribe'
const LIVE_TRANSCRIPTION_MODEL = 'gpt-live-transcribe'
const LOCAL_TRANSCRIPTION_MODEL = 'parakeet-tdt-0.6b-v3'

function formatMegabytes(bytes: number) {
  return `${Math.round(bytes / 1_000_000)} MB`
}

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

function wait(milliseconds: number) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds))
}

/**
 * Voice-reactive bars drawn at display rate with direct DOM writes, so the overlay stays
 * smooth without re-rendering React. Level rises fast and falls slowly, like a VU meter.
 */
function Waveform({ levelRef, state }: { levelRef: MutableRefObject<number>, state: OverlayState }) {
  const barsRef = useRef<(HTMLSpanElement | null)[]>([])
  const stateRef = useRef(state)
  stateRef.current = state

  useEffect(() => {
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const heights = new Array(WAVEFORM_BAR_COUNT).fill(WAVEFORM_MIN_HEIGHT)
    const startedAt = performance.now()
    let smoothedLevel = 0
    let frame = 0

    const draw = (now: number) => {
      const seconds = (now - startedAt) / 1000
      const current = stateRef.current
      const target = current === 'recording' ? normalizeAudioLevel(levelRef.current) : 0
      smoothedLevel += (target - smoothedLevel) * (target > smoothedLevel ? 0.5 : 0.1)

      barsRef.current.forEach((bar, index) => {
        if (!bar) return
        const position = index / (WAVEFORM_BAR_COUNT - 1)
        const offset = position * 2 - 1
        let goal = WAVEFORM_MIN_HEIGHT
        if (current === 'recording') {
          const envelope = Math.exp(-offset * offset * 2.4)
          const shimmer = reduceMotion ? 1 : 0.62 + 0.38 * Math.abs(Math.sin(seconds * 7.5 + index * 1.7) * Math.sin(seconds * 2.3 + index * 0.45))
          goal += (WAVEFORM_MAX_HEIGHT - WAVEFORM_MIN_HEIGHT) * smoothedLevel * envelope * shimmer
        } else if (current === 'processing' && !reduceMotion) {
          // A soft highlight sweeps across while the transcript is prepared.
          const sweep = ((seconds * 0.9) % 1.6) - 0.3
          const distance = position - sweep
          goal += 7 * Math.exp(-(distance * distance) / 0.012)
        }
        heights[index] += (goal - heights[index]) * 0.3
        bar.style.height = `${heights[index].toFixed(1)}px`
      })
      frame = window.requestAnimationFrame(draw)
    }

    frame = window.requestAnimationFrame(draw)
    return () => window.cancelAnimationFrame(frame)
  }, [levelRef])

  return (
    <div className={`pill-waveform ${state}`} aria-hidden="true">
      {Array.from({ length: WAVEFORM_BAR_COUNT }, (_, index) => (
        <span key={index} ref={(bar) => { barsRef.current[index] = bar }} className="pill-bar" />
      ))}
    </div>
  )
}

function PauseIcon() {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="4" y="3" width="2.6" height="10" rx="1" /><rect x="9.4" y="3" width="2.6" height="10" rx="1" /></svg>
}

function PlayIcon() {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3.3v9.4a.8.8 0 0 0 1.2.7l7.4-4.7a.8.8 0 0 0 0-1.4L6.2 2.6A.8.8 0 0 0 5 3.3Z" /></svg>
}

function CloseIcon() {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5l7 7m0-7l-7 7" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
}

function StopIcon() {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3.5" y="3.5" width="9" height="9" rx="2.2" /></svg>
}

function CheckIcon() {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><path className="check-path" d="M3.5 8.4l3 3 6-6.6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
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

function App() {
  const [status, setStatus] = useState<Status>('idle')
  const [viewMode, setViewMode] = useState<ViewMode>('settings')
  const [transcript, setTranscript] = useState<string>('')
  const [error, setError] = useState<string>('')
  const [audioLevel, setAudioLevel] = useState<number>(0)
  const [overlayLeaving, setOverlayLeaving] = useState(false)
  const [apiKey, setApiKey] = useState<string>('')
  const [showRecordingOverlay, setShowRecordingOverlay] = useState<boolean>(true)
  const [realtimeTranscriptionEnabled, setRealtimeTranscriptionEnabled] = useState<boolean>(false)
  const [prompt, setPrompt] = useState<string>('')
  const [postProcessEnabled, setPostProcessEnabled] = useState<boolean>(false)
  const [postProcessPrompt, setPostProcessPrompt] = useState<string>(DEFAULT_POST_PROCESS_PROMPT)
  const [historyRetentionDays, setHistoryRetentionDays] = useState<number>(DEFAULT_HISTORY_RETENTION_DAYS)
  const [transcriptHistory, setTranscriptHistory] = useState<TranscriptHistoryEntry[]>([])
  const [appLogs, setAppLogs] = useState<AppLogEntry[]>([])
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('record')
  const [transcriptionProvider, setTranscriptionProvider] = useState<TranscriptionProvider>('openai')
  const [localModelStatus, setLocalModelStatus] = useState<LocalModelStatus | null>(null)
  const [downloadProgress, setDownloadProgress] = useState<DownloadProgress | null>(null)

  const levelIntervalRef = useRef<number | null>(null)
  const hideTimerRef = useRef<number | null>(null)
  const levelRef = useRef(0)
  const viewModeRef = useRef<ViewMode>('settings')
  const overlayVisibleRef = useRef(false)
  const liveTranscriptionStartedRef = useRef(false)
  const localTranscriptionStartedRef = useRef(false)
  const transitionInProgressRef = useRef(false)
  const settingSaveTimersRef = useRef<Record<string, number>>({})

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

  const pruneStoredRecordings = useCallback(async (retentionDays: number) => {
    try {
      const result = await invoke<RecordingPruneResult>('prune_recordings', { retentionDays })
      if (result.deleted_count > 0) {
        const freedMegabytes = (result.freed_bytes / 1_000_000).toFixed(1)
        addLog(`Deleted ${result.deleted_count} expired recordings (${freedMegabytes} MB)`, 'success')
      }
      if (result.failed_count > 0) {
        addLog(`Could not delete ${result.failed_count} expired recordings`, 'error')
      }
    } catch (pruneError) {
      addLog(`Failed to apply recording retention: ${pruneError}`, 'error')
    }
  }, [addLog])

  const persistSetting = useCallback(async (
    label: string,
    command: string,
    args: Record<string, unknown>,
  ) => {
    try {
      await invoke(command, args)
    } catch (saveError) {
      const message = `Failed to save ${label}: ${saveError}`
      setError(message)
      addLog(message, 'error')
    }
  }, [addLog])

  const scheduleSettingSave = useCallback((
    key: string,
    label: string,
    command: string,
    args: Record<string, unknown>,
  ) => {
    const pendingTimer = settingSaveTimersRef.current[key]
    if (pendingTimer !== undefined) window.clearTimeout(pendingTimer)

    settingSaveTimersRef.current[key] = window.setTimeout(() => {
      delete settingSaveTimersRef.current[key]
      persistSetting(label, command, args)
    }, 350)
  }, [persistSetting])

  const saveTranscriptHistory = useCallback((nextHistory: TranscriptHistoryEntry[]) => {
    try {
      window.localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(nextHistory))
    } catch (storageError) {
      const message = `Failed to save transcript history: ${storageError}`
      setError(message)
      addLog(message, 'error')
    }
  }, [addLog])

  const addTranscriptToHistory = useCallback((nextTranscript: string, model: string, postProcessApplied: boolean) => {
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
  }, [historyRetentionDays, saveTranscriptHistory])

  const handleHistoryRetentionChange = useCallback((value: number) => {
    const nextRetentionDays = normalizeRetentionDays(value)
    setHistoryRetentionDays(nextRetentionDays)
    try {
      window.localStorage.setItem(HISTORY_RETENTION_STORAGE_KEY, String(nextRetentionDays))
    } catch (storageError) {
      const message = `Failed to save history retention: ${storageError}`
      setError(message)
      addLog(message, 'error')
    }

    setTranscriptHistory((currentHistory) => {
      const nextHistory = pruneHistory(currentHistory, nextRetentionDays)
      saveTranscriptHistory(nextHistory)
      return nextHistory
    })

    pruneStoredRecordings(nextRetentionDays)
  }, [addLog, pruneStoredRecordings, saveTranscriptHistory])

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

  const resetWaveform = useCallback(() => {
    levelRef.current = 0
  }, [])

  const changeViewMode = useCallback((mode: ViewMode) => {
    viewModeRef.current = mode
    setViewMode(mode)
  }, [])

  const hideWindow = useCallback(async () => {
    if (overlayVisibleRef.current) {
      // Let the pill fade out before the window disappears.
      overlayVisibleRef.current = false
      setOverlayLeaving(true)
      await wait(OVERLAY_EXIT_MS)
    }
    await appWindow.setAlwaysOnTop(false)
    await appWindow.hide()
    setOverlayLeaving(false)
  }, [])

  const showOverlayWindow = useCallback(async () => {
    changeViewMode('overlay')
    setOverlayLeaving(false)

    const screenWidth = window.screen.availWidth || window.screen.width || OVERLAY_WINDOW_SIZE.width
    const screenTop = (window.screen as Screen & { availTop?: number }).availTop ?? 0
    const x = Math.max(0, Math.round((screenWidth - OVERLAY_WINDOW_SIZE.width) / 2))
    const y = Math.max(12, screenTop + 12)

    if (!overlayVisibleRef.current) {
      await Promise.all([
        appWindow.setSize(new LogicalSize(OVERLAY_WINDOW_SIZE.width, OVERLAY_WINDOW_SIZE.height)),
        appWindow.setPosition(new LogicalPosition(x, y)),
        appWindow.setAlwaysOnTop(true),
        invoke('set_window_shadow', { enabled: false }),
      ])
    }
    overlayVisibleRef.current = true
    await appWindow.show()
  }, [changeViewMode])

  const showSettingsWindow = useCallback(async () => {
    clearHideTimer()
    overlayVisibleRef.current = false
    setOverlayLeaving(false)
    changeViewMode('settings')

    const availableHeight = window.screen.availHeight || SETTINGS_WINDOW_SIZE.height
    const height = Math.min(SETTINGS_WINDOW_SIZE.height, Math.max(560, availableHeight - 56))

    await Promise.all([
      appWindow.setAlwaysOnTop(false),
      invoke('set_window_shadow', { enabled: true }),
    ])
    await appWindow.setSize(new LogicalSize(SETTINGS_WINDOW_SIZE.width, height))
    await appWindow.center()
    await appWindow.show()
    await appWindow.setFocus()
  }, [changeViewMode, clearHideTimer])

  const returnToIdleAndHide = useCallback(async () => {
    clearHideTimer()
    clearLevelPolling()
    invoke('set_tray_status', { status: 'idle' }).catch(() => {})
    await hideWindow()
    setStatus('idle')
    changeViewMode('settings')
    setAudioLevel(0)
    resetWaveform()
  }, [changeViewMode, clearHideTimer, clearLevelPolling, hideWindow, resetWaveform])

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
        levelRef.current = level
        // The overlay reads the ref at display rate; only the settings meter needs React state.
        if (viewModeRef.current === 'settings') setAudioLevel(level)
      } catch {
        clearLevelPolling()
      }
    }, 50)
  }, [clearLevelPolling])

  useEffect(() => {
    addLog('Scribe ready')

    const reportLoadError = (label: string, loadError: unknown) => {
      const message = `Failed to load ${label}: ${loadError}`
      setError(message)
      addLog(message, 'error')
    }

    let savedRetentionDays = DEFAULT_HISTORY_RETENTION_DAYS
    let savedHistory: string | null = null
    let canApplySavedRetention = true
    try {
      const savedRetention = window.localStorage.getItem(HISTORY_RETENTION_STORAGE_KEY)
      const parsedRetention = Number(savedRetention ?? DEFAULT_HISTORY_RETENTION_DAYS)
      if (!Number.isFinite(parsedRetention)) {
        canApplySavedRetention = false
        reportLoadError('history retention', 'saved value is invalid')
      } else {
        savedRetentionDays = normalizeRetentionDays(parsedRetention)
      }
      savedHistory = window.localStorage.getItem(HISTORY_STORAGE_KEY)
    } catch (storageError) {
      canApplySavedRetention = false
      reportLoadError('local history', storageError)
    }
    setHistoryRetentionDays(savedRetentionDays)
    if (canApplySavedRetention) pruneStoredRecordings(savedRetentionDays)

    if (savedHistory) {
      try {
        const parsedHistory = JSON.parse(savedHistory) as TranscriptHistoryEntry[]
        const nextHistory = pruneHistory(parsedHistory, savedRetentionDays)
        setTranscriptHistory(nextHistory)
        saveTranscriptHistory(nextHistory)
      } catch (historyError) {
        reportLoadError('transcript history', historyError)
        setTranscriptHistory([])
        saveTranscriptHistory([])
      }
    }

    invoke<Settings>('get_settings').then((settings) => {
      setApiKey(settings.api_key)
      setShowRecordingOverlay(settings.show_recording_overlay)
      setRealtimeTranscriptionEnabled(settings.realtime_transcription_enabled)
      setPrompt(settings.prompt)
      setPostProcessEnabled(settings.post_process_enabled)
      if (settings.post_process_prompt) setPostProcessPrompt(settings.post_process_prompt)
      setTranscriptionProvider(settings.transcription_provider)
    }).catch((loadError) => reportLoadError('settings', loadError))

    invoke<LocalModelStatus>('get_local_model_status')
      .then(setLocalModelStatus)
      .catch((loadError) => reportLoadError('local model status', loadError))
  }, [addLog, pruneStoredRecordings, saveTranscriptHistory])

  useEffect(() => {
    const unlisten = listen<DownloadProgress>('local-model-download-progress', (event) => {
      setDownloadProgress(event.payload)
    })

    return () => {
      unlisten.then((dispose) => dispose())
    }
  }, [])

  useEffect(() => {
    return () => {
      clearLevelPolling()
      clearHideTimer()
      Object.values(settingSaveTimersRef.current).forEach((timer) => window.clearTimeout(timer))
    }
  }, [clearHideTimer, clearLevelPolling])

  const handleApiKeyChange = (key: string) => {
    setApiKey(key)
    scheduleSettingSave('api-key', 'API key', 'set_api_key', { apiKey: key })
  }

  const handleShowRecordingOverlayChange = async (enabled: boolean) => {
    setShowRecordingOverlay(enabled)
    await persistSetting('recording HUD preference', 'set_show_recording_overlay', { showRecordingOverlay: enabled })
  }

  const handleRealtimeTranscriptionChange = async (enabled: boolean) => {
    setRealtimeTranscriptionEnabled(enabled)
    addLog(enabled ? 'Realtime transcription enabled' : 'Realtime transcription disabled')
    await persistSetting('realtime transcription preference', 'set_realtime_transcription_enabled', { realtimeTranscriptionEnabled: enabled })
  }

  const handleTranscriptionProviderChange = async (provider: TranscriptionProvider) => {
    setTranscriptionProvider(provider)
    addLog(provider === 'local' ? 'Using local transcription' : 'Using OpenAI transcription')
    await persistSetting('transcription provider', 'set_transcription_provider', { transcriptionProvider: provider })
  }

  const downloadLocalModel = async () => {
    setDownloadProgress({ downloaded_bytes: 0, total_bytes: localModelStatus?.total_bytes ?? 0 })
    setLocalModelStatus((current) => current && { ...current, downloading: true })
    addLog(`Downloading ${LOCAL_TRANSCRIPTION_MODEL}`)
    try {
      await invoke('download_local_model')
      addLog('Local model downloaded', 'success')
    } catch (downloadError) {
      const message = `Failed to download local model: ${downloadError}`
      setError(message)
      addLog(message, 'error')
    } finally {
      setDownloadProgress(null)
      invoke<LocalModelStatus>('get_local_model_status').then(setLocalModelStatus).catch(() => {})
    }
  }

  const handlePromptChange = (nextPrompt: string) => {
    setPrompt(nextPrompt)
    scheduleSettingSave('prompt', 'vocabulary hints', 'set_prompt', { prompt: nextPrompt })
  }

  const handlePostProcessEnabledChange = async (enabled: boolean) => {
    setPostProcessEnabled(enabled)
    addLog(enabled ? 'Post-processing enabled' : 'Post-processing disabled')
    await persistSetting('post-processing preference', 'set_post_process_enabled', { postProcessEnabled: enabled })
  }

  const handlePostProcessPromptChange = (nextPrompt: string) => {
    setPostProcessPrompt(nextPrompt)
    scheduleSettingSave('post-process-prompt', 'post-processing prompt', 'set_post_process_prompt', { postProcessPrompt: nextPrompt })
  }

  const startRecording = useCallback(async () => {
    if (status === 'recording' || transitionInProgressRef.current) return

    clearHideTimer()

    const setupError = transcriptionProvider === 'local'
      ? (localModelStatus?.installed ? null : 'Download the local model in Settings first')
      : (apiKey ? null : 'Please enter your OpenAI API key first')
    if (setupError) {
      setError(setupError)
      setStatus('error')
      addLog(setupError, 'error')
      setSettingsTab('settings')
      await showSettingsWindow()
      invoke('play_sound', { sound: 'error' }).catch(() => {})
      return
    }

    transitionInProgressRef.current = true

    setError('')
    setTranscript('')
    setAudioLevel(0)
    resetWaveform()

    let recordingStarted = false
    // Show the overlay while the microphone opens instead of after.
    const overlayShown = showRecordingOverlay ? showOverlayWindow() : Promise.resolve()

    try {
      await invoke('start_recording')
      recordingStarted = true
      setStatus('recording')
      startAudioPolling()
      liveTranscriptionStartedRef.current = false
      localTranscriptionStartedRef.current = false
      if (transcriptionProvider === 'local') {
        try {
          await invoke('start_local_transcription')
          localTranscriptionStartedRef.current = true
        } catch (localError) {
          addLog(`Local transcription will run after stopping: ${localError}`, 'error')
        }
      } else if (!realtimeTranscriptionEnabled) {
        invoke('prewarm_openai_connection').catch(() => {})
      }
      if (transcriptionProvider === 'openai' && realtimeTranscriptionEnabled) {
        try {
          const bufferedMilliseconds = await invoke<number>('start_live_transcription', {
            apiKey,
            prompt,
          })
          liveTranscriptionStartedRef.current = true
          addLog(
            bufferedMilliseconds > 0
              ? `Realtime transcription started with ${bufferedMilliseconds} ms of buffered audio`
              : `Realtime transcription started with ${LIVE_TRANSCRIPTION_MODEL}`,
          )
        } catch (liveError) {
          addLog(`Realtime unavailable; using standard transcription: ${liveError}`, 'error')
        }
      }
      await invoke('register_escape_hotkey')
      addLog('Recording started')
      await overlayShown
      if (!showRecordingOverlay) await hideWindow()
    } catch (recordingError) {
      clearLevelPolling()
      await overlayShown.catch(() => {})
      invoke('unregister_escape_hotkey').catch(() => {})
      if (liveTranscriptionStartedRef.current) {
        await invoke('cancel_live_transcription').catch(() => {})
        liveTranscriptionStartedRef.current = false
      }
      if (localTranscriptionStartedRef.current) {
        await invoke('cancel_local_transcription').catch(() => {})
        localTranscriptionStartedRef.current = false
      }
      if (recordingStarted) await invoke('cancel_recording').catch(() => {})
      const message = `Failed to start recording: ${recordingError}`
      setError(message)
      setStatus('error')
      addLog(message, 'error')
      if (shouldShowSettingsForError(message)) setSettingsTab('settings')
      invoke('set_tray_status', { status: 'error' }).catch(() => {})
      invoke('play_sound', { sound: 'error' }).catch(() => {})
      await showSettingsWindow()
    } finally {
      transitionInProgressRef.current = false
    }
  }, [addLog, apiKey, clearHideTimer, clearLevelPolling, hideWindow, localModelStatus, prompt, realtimeTranscriptionEnabled, resetWaveform, showOverlayWindow, showRecordingOverlay, showSettingsWindow, startAudioPolling, status, transcriptionProvider])

  // Returns the raw transcript and the model that produced it, preferring work already done
  // during recording and falling back to the saved WAV.
  const transcribeRecording = useCallback(async (audioPath: string): Promise<{ transcript: string, model: string }> => {
    if (localTranscriptionStartedRef.current || transcriptionProvider === 'local') {
      const startedDuringRecording = localTranscriptionStartedRef.current
      localTranscriptionStartedRef.current = false
      if (startedDuringRecording) {
        try {
          return { transcript: await invoke<string>('finish_local_transcription'), model: LOCAL_TRANSCRIPTION_MODEL }
        } catch (localError) {
          addLog(`Local transcription failed; retrying from saved audio: ${localError}`, 'error')
        }
      }
      return { transcript: await invoke<string>('transcribe_local', { audioPath }), model: LOCAL_TRANSCRIPTION_MODEL }
    }

    if (liveTranscriptionStartedRef.current) {
      liveTranscriptionStartedRef.current = false
      try {
        const transcript = await invoke<string>('finish_live_transcription')
        addLog('Realtime transcript completed')
        return { transcript, model: LIVE_TRANSCRIPTION_MODEL }
      } catch (liveError) {
        addLog(`Realtime transcription failed; retrying from saved audio: ${liveError}`, 'error')
      }
    }

    const transcript = await invoke<string>('transcribe', { audioPath, apiKey, prompt: prompt || null })
    return { transcript, model: FILE_TRANSCRIPTION_MODEL }
  }, [addLog, apiKey, prompt, transcriptionProvider])

  const stopRecording = useCallback(async () => {
    if (!isRecordingStatus(status) || transitionInProgressRef.current) return

    transitionInProgressRef.current = true

    clearHideTimer()
    invoke('unregister_escape_hotkey').catch(() => {})
    clearLevelPolling()
    setAudioLevel(0)
    setStatus('processing')

    try {
      // Stop the microphone first; the overlay resize must not delay the end of capture.
      const [audioPath] = await Promise.all([
        invoke<string>('stop_recording'),
        showRecordingOverlay ? showOverlayWindow() : Promise.resolve(),
      ])
      invoke('set_tray_status', { status: 'processing' }).catch(() => {})
      addLog(postProcessEnabled ? 'Finishing transcript with post-processing' : 'Finishing transcript')

      const startedAt = performance.now()
      const { transcript: rawTranscript, model: transcriptionModel } = await transcribeRecording(audioPath)
      const result = await invoke<TranscriptionResult>('finalize_transcript', {
        transcript: rawTranscript,
        apiKey,
        postProcessEnabled,
        postProcessPrompt: postProcessPrompt || null,
      })
      addLog(`Transcribed with ${transcriptionModel} in ${Math.round(performance.now() - startedAt)} ms after stopping`)

      if (result.post_process_error) {
        addLog(`Post-processing skipped: ${result.post_process_error}`, 'error')
      }

      setTranscript(result.transcript)
      addTranscriptToHistory(result.transcript, transcriptionModel, result.post_process_applied)
      pruneStoredRecordings(historyRetentionDays)
      await writeText(result.transcript)
      await invoke('set_tray_status', { status: 'success' })
      addLog(result.post_process_applied ? 'Cleaned transcript copied to clipboard' : 'Transcript copied to clipboard', 'success')
      invoke('play_sound', { sound: 'success' }).catch(() => {})

      await sendNotification({
        title: 'Scribe',
        body: 'Copied to clipboard',
      })

      setStatus('success')
      scheduleHide(SUCCESS_HIDE_DELAY_MS)
    } catch (stopError) {
      if (liveTranscriptionStartedRef.current) {
        invoke('cancel_live_transcription').catch(() => {})
        liveTranscriptionStartedRef.current = false
      }
      if (localTranscriptionStartedRef.current) {
        invoke('cancel_local_transcription').catch(() => {})
        localTranscriptionStartedRef.current = false
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
    } finally {
      transitionInProgressRef.current = false
    }
  }, [addLog, addTranscriptToHistory, apiKey, clearHideTimer, clearLevelPolling, historyRetentionDays, postProcessEnabled, postProcessPrompt, pruneStoredRecordings, scheduleHide, showOverlayWindow, showRecordingOverlay, showSettingsWindow, status, transcribeRecording])

  const cancelRecording = useCallback(async () => {
    if (!isRecordingStatus(status) || transitionInProgressRef.current) return

    transitionInProgressRef.current = true

    clearHideTimer()
    invoke('unregister_escape_hotkey').catch(() => {})
    clearLevelPolling()
    setAudioLevel(0)
    resetWaveform()

    if (liveTranscriptionStartedRef.current) {
      invoke('cancel_live_transcription').catch(() => {})
      liveTranscriptionStartedRef.current = false
    }
    if (localTranscriptionStartedRef.current) {
      invoke('cancel_local_transcription').catch(() => {})
      localTranscriptionStartedRef.current = false
    }

    try {
      await invoke('cancel_recording')
      setError('')
      addLog('Recording canceled')
      await hideWindow()
      setStatus('idle')
      changeViewMode('settings')
    } catch (cancelError) {
      const message = `Failed to cancel recording: ${cancelError}`
      setError(message)
      setStatus('error')
      addLog(message, 'error')
    } finally {
      transitionInProgressRef.current = false
    }
  }, [addLog, changeViewMode, clearHideTimer, clearLevelPolling, hideWindow, resetWaveform, status])

  const togglePause = useCallback(async () => {
    if (!isRecordingStatus(status) || transitionInProgressRef.current) return

    transitionInProgressRef.current = true

    try {
      const paused = await invoke<boolean>('pause_recording')
      setStatus(paused ? 'paused' : 'recording')
      if (paused) {
        setAudioLevel(0)
        resetWaveform()
      }
    } catch (pauseError) {
      const message = `Failed to toggle pause: ${pauseError}`
      setError(message)
      addLog(message, 'error')
    } finally {
      transitionInProgressRef.current = false
    }
  }, [addLog, resetWaveform, status])

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

  const renderOverlay = () => {
    const overlayState: OverlayState = status === 'idle' ? 'starting' : status

    return (
      <div className={`app overlay ${overlayLeaving ? 'leaving' : ''}`}>
        <div className={`pill ${overlayState}`} data-tauri-drag-region>
          <span className={`pill-dot ${overlayState}`} aria-hidden="true" />

          {overlayState === 'error' ? (
            <span className="pill-message error" title={error} role="alert">{error || 'Something went wrong'}</span>
          ) : (
            <Waveform levelRef={levelRef} state={overlayState} />
          )}

          <div className="pill-trailing" key={isRecordingStatus(status) ? 'controls' : overlayState}>
            {(overlayState === 'starting' || isRecordingStatus(status)) && (
              <>
                <button
                  type="button"
                  className="pill-button"
                  onClick={togglePause}
                  disabled={overlayState === 'starting'}
                  title={status === 'paused' ? 'Resume' : 'Pause'}
                  aria-label={status === 'paused' ? 'Resume recording' : 'Pause recording'}
                >
                  {status === 'paused' ? <PlayIcon /> : <PauseIcon />}
                </button>
                <button
                  type="button"
                  className="pill-button"
                  onClick={cancelRecording}
                  disabled={overlayState === 'starting'}
                  title="Cancel (Esc)"
                  aria-label="Cancel recording"
                >
                  <CloseIcon />
                </button>
                <button
                  type="button"
                  className="pill-button stop"
                  onClick={stopRecording}
                  disabled={overlayState === 'starting'}
                  title="Stop (⌘⇧Space)"
                  aria-label="Stop recording"
                >
                  <StopIcon />
                </button>
              </>
            )}

            {overlayState === 'processing' && <span className="pill-label">Transcribing</span>}

            {overlayState === 'success' && (
              <span className="pill-label success"><CheckIcon />Copied</span>
            )}
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

                <label className="field-label" htmlFor="transcription-provider">Engine</label>
                <select
                  id="transcription-provider"
                  className="field-input"
                  value={transcriptionProvider}
                  onChange={(event) => handleTranscriptionProviderChange(event.target.value as TranscriptionProvider)}
                >
                  <option value="openai">OpenAI (cloud)</option>
                  <option value="local">On this Mac (private, offline)</option>
                </select>

                {transcriptionProvider === 'local' ? (
                  <>
                    <p className="body-hint">
                      Uses <code>{LOCAL_TRANSCRIPTION_MODEL}</code> on this Mac, transcribing while you speak.
                      Vocabulary hints apply to OpenAI only.
                    </p>
                    {localModelStatus?.installed ? (
                      <p className="body-hint"><span className="status-text on">Model ready</span></p>
                    ) : downloadProgress ? (
                      <>
                        <div className="audio-level" aria-hidden="true">
                          <div
                            className="audio-level-bar"
                            style={{ width: `${downloadProgress.total_bytes ? (downloadProgress.downloaded_bytes / downloadProgress.total_bytes) * 100 : 0}%` }}
                          />
                        </div>
                        <p className="body-hint">
                          Downloading {formatMegabytes(downloadProgress.downloaded_bytes)} of {formatMegabytes(downloadProgress.total_bytes)}
                        </p>
                      </>
                    ) : (
                      <button
                        type="button"
                        className="text-button"
                        onClick={downloadLocalModel}
                        disabled={localModelStatus?.downloading}
                      >
                        Download model ({formatMegabytes(localModelStatus?.total_bytes ?? 0)})
                      </button>
                    )}
                  </>
                ) : (
                  <p className="body-hint">Recorded audio uses <code>{FILE_TRANSCRIPTION_MODEL}</code>. Live transcription uses <code>{LIVE_TRANSCRIPTION_MODEL}</code> when enabled.</p>
                )}

                <label className="field-label" htmlFor="api-key">OpenAI API key</label>
                <input
                  id="api-key"
                  type="password"
                  className="field-input mono"
                  placeholder="sk-..."
                  value={apiKey}
                  onChange={(event) => handleApiKeyChange(event.target.value)}
                />
                {transcriptionProvider === 'local' && (
                  <p className="body-hint">Optional with the local engine; only used for post-processing.</p>
                )}
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

                {transcriptionProvider === 'openai' && <label className="checkbox-setting">
                  <input
                    type="checkbox"
                    checked={realtimeTranscriptionEnabled}
                    onChange={(event) => handleRealtimeTranscriptionChange(event.target.checked)}
                  />
                  <span>
                    <strong>Transcribe while recording</strong>
                    <small>Reduces the wait after stopping with {LIVE_TRANSCRIPTION_MODEL}.</small>
                  </span>
                </label>}
              </section>

              <section className="panel-block" aria-labelledby="cleanup-heading">
                <div className="panel-block-head">
                  <h2 id="cleanup-heading">Post-processing</h2>
                  <span className={`status-text ${postProcessEnabled ? 'on' : ''}`}>{postProcessEnabled ? 'On' : 'Off'}</span>
                </div>
                <p className="body-hint">Optional cleanup pass with gpt-4o-mini before copying. Needs an OpenAI API key.</p>

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
                    Clear text history
                  </button>
                </div>
                <p className="body-hint">Previous transcriptions and source audio are stored locally on this Mac.</p>

                <label className="field-label" htmlFor="history-retention-days">Expire text and audio after (days)</label>
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

  return showRecordingOverlay && viewMode === 'overlay' ? renderOverlay() : renderSettings()
}

export default App
