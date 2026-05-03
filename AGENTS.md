# Scribe

macOS voice-to-text app. Tauri + React + Rust.

## Structure
```
src/App.tsx              # React UI, recording state
src-tauri/src/main.rs    # Rust: audio, API, tray, hotkeys
```

## Commands
```bash
npm run tauri dev        # Dev mode
npm run tauri build      # Build .app
```

## Key Patterns
- Global hotkey registered in Rust, emits event to frontend
- Frontend calls Rust commands: `start_recording`, `stop_recording`, `transcribe`
- Single hidden Tauri window is reused for both settings and the optional recording overlay HUD
- Recording overlay can be disabled; when disabled, dictation stays minimized unless Scribe needs attention
- Tray status: 🔴 recording, ⏳ processing, ✅ success, ❌ error
- Audio saved to `~/Library/VoiceTranscripts/`
- Settings stored in `~/Library/Application Support/scribe/config.json` (`api_key`, `model`, `show_recording_overlay`)
