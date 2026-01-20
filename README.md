# Scribe 🎙️

Lightweight voice-to-text transcription for macOS. Press a hotkey, speak, get text in your clipboard.

## Why

I wanted something simple: hotkey → speak → clipboard. No subscriptions, no account, no bloat. Just my own API key.

## Features

- **Global Hotkey**: `Cmd+Shift+Space` to start/stop recording
- **OpenAI Whisper**: Fast, accurate transcription
- **Menubar App**: Lives in your system tray
- **Auto-clipboard**: Transcriptions copied automatically

## Setup

### Prerequisites

- Node.js 18+
- Rust (install via [rustup](https://rustup.rs/))
- Xcode Command Line Tools (`xcode-select --install`)

### Installation

```bash
cd ~/Documents/code/scribe

# Install dependencies
npm install

# Run in development mode
npm run tauri dev

# Build for production
npm run tauri build
```

### First Run

1. Click the Scribe icon in your menubar (or run in dev mode)
2. Enter your OpenAI API key (get one at [platform.openai.com](https://platform.openai.com))
3. Press `Cmd+Shift+Space` to start recording
4. Speak, then press the hotkey again (or click Stop)
5. Text is automatically copied to your clipboard!

## Usage

| Action | Trigger |
|--------|---------|
| Toggle recording | `Cmd+Shift+Space` |
| Show/hide window | Click tray icon |
| Stop recording | Press hotkey again or click Stop |

## File Locations

- **Audio recordings**: `~/Library/VoiceTranscripts/`
- **Config (API key)**: `~/Library/Application Support/scribe/config.json`

## Tech Stack

- **Tauri** (Rust) - Native app shell
- **React** + TypeScript - UI
- **cpal** - Audio capture
- **OpenAI `gpt-4o-mini-transcribe`** - Fast, accurate transcription with prompt support

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
