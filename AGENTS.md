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
cd src-tauri && cargo test  # Rust tests
```

## Key Patterns
- Global hotkey registered in Rust, emits event to frontend
- Frontend calls Rust commands for batch transcription and optional realtime transcription; realtime failures fall back to the saved WAV
- Single hidden Tauri window is reused for both settings and the optional recording overlay HUD
- Recording overlay can be disabled; when disabled, dictation stays minimized unless Scribe needs attention
- Tray icon: `src-tauri/icons/icon.png` is a transparent monochrome macOS template image (`iconAsTemplate: true`). Do not replace it with a full-color or opaque app icon, macOS renders its alpha silhouette as a solid menu-bar shape.
- Tray status: 🔴 recording, ⏳ processing, ✅ success, ❌ error
- Audio saved to `~/Library/VoiceTranscripts/`
- API key stored in macOS Keychain (`com.scribe.app` / `openai-api-key`)
- Settings stored in `~/Library/Application Support/scribe/config.json` (`show_recording_overlay`, `realtime_transcription_enabled`, `prompt`, `post_process_enabled`, `post_process_prompt`; legacy `api_key` is migrated to Keychain on read)
- Transcript history is stored locally in the Tauri webview `localStorage` with user-configurable day-based retention

## Release
Read `.pi/skills/release/SKILL.md` before creating a release.
