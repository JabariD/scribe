# Scribe 🎙️

Lightweight voice-to-text transcription for **macOS only**. Press a hotkey, speak, get text in your clipboard.

## Why

I wanted something simple: hotkey → speak → clipboard. No subscriptions, no account, no bloat. Just my own API key.

## Features

- **Global Hotkey**: `Cmd+Shift+Space` to start/stop recording
- **Pause & Cancel**: Pause mid-recording or cancel with `Escape`
- **OpenAI transcription**: Fast, accurate transcription with optional realtime processing while you speak
- **Menubar App**: Lives in your system tray
- **Auto-clipboard**: Transcriptions copied automatically
- **Optional realtime mode**: Process speech while recording to reduce the wait after stopping
- **Optional cleanup pass**: Remove filler words and fix punctuation, spelling, and grammar before copying
- **Local history**: Previous transcripts are saved locally with configurable expiration

## Install

### Option 1: Download (easiest)
1. Download from [Releases](https://github.com/JabariD/scribe/releases):
   - `Scribe_X.X.X_aarch64.dmg` (recommended) or
   - `Scribe_X.X.X_aarch64.zip`
2. Open DMG and drag to Applications, or unzip and drag `Scribe.app` to `/Applications`
3. First launch: Right-click → Open (macOS blocks unsigned apps)

### Option 2: Build from source
```bash
git clone https://github.com/JabariD/scribe.git
cd scribe
npm install
npm run tauri build
cp -r src-tauri/target/release/bundle/macos/Scribe.app /Applications/
```

Requires: Node.js 18+, Rust, Xcode CLI tools

## First Run

1. Click the Scribe icon in your menubar (or run in dev mode)
2. Enter your OpenAI API key (get one at [platform.openai.com](https://platform.openai.com))
3. Press `Cmd+Shift+Space` to start recording
4. Speak, then press the hotkey again (or click Stop)
5. Text is automatically copied to your clipboard!

## Usage

| Action | Trigger |
|--------|---------|
| Toggle recording | `Cmd+Shift+Space` |
| Cancel recording | `Escape` |
| Pause/resume | Click ⏸️ button |
| Show/hide window | Click tray icon |

## File Locations

- **Audio recordings**: `~/Library/VoiceTranscripts/`
- **API key**: macOS Keychain
- **Config**: `~/Library/Application Support/scribe/config.json`
- **Transcript history**: Stored locally in the app webview storage

## Tech Stack

- **Tauri** (Rust) - Native app shell
- **React** + TypeScript - UI
- **cpal** - Audio capture
- **OpenAI transcription models** (`whisper-1`, `gpt-4o-mini-transcribe`, `gpt-4o-transcribe`) - Speech-to-text
- **OpenAI text model** (`gpt-4o-mini`) - Optional transcript cleanup

## Permissions Required

On first run, macOS will ask for:
- **Microphone access** - Required for recording

## Cost

OpenAI Whisper API costs ~$0.006/minute of audio. A typical 30-second recording costs less than $0.01.

## Roadmap

- [ ] Local transcription with whisper.cpp (offline mode)
- [ ] Auto-stop on silence (VAD)
- [ ] Context-aware corrections
- [ ] History view
- [ ] Custom hotkey configuration
