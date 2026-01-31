// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod recording;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use recording::RecordingState;
use serde::{Deserialize, Serialize};
use std::fs::{self, File};
use std::io::BufWriter;
use std::path::PathBuf;
use std::process::Command;
use std::sync::Arc;
use tauri::{
    CustomMenuItem, GlobalShortcutManager, Manager, SystemTray, SystemTrayEvent, SystemTrayMenu,
    SystemTrayMenuItem,
};

#[derive(Serialize, Deserialize, Default)]
struct Config {
    api_key: Option<String>,
}

fn get_config_path() -> PathBuf {
    let config_dir = dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("scribe");
    fs::create_dir_all(&config_dir).ok();
    config_dir.join("config.json")
}

fn load_config() -> Config {
    let path = get_config_path();
    if path.exists() {
        fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    } else {
        Config::default()
    }
}

fn save_config(config: &Config) {
    let path = get_config_path();
    if let Ok(json) = serde_json::to_string_pretty(config) {
        fs::write(path, json).ok();
    }
}

fn get_transcripts_dir() -> PathBuf {
    let dir = dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Library")
        .join("VoiceTranscripts");
    fs::create_dir_all(&dir).ok();
    dir
}

// Icons embedded at compile time
const ICON_NORMAL: &[u8] = include_bytes!("../icons/icon.png");
const ICON_RECORDING: &[u8] = include_bytes!("../icons/icon-recording.png");

// Update tray status indicator
#[tauri::command]
fn set_tray_status(app: tauri::AppHandle, status: String) {
    let indicator = match status.as_str() {
        "recording" => "🔴",
        "processing" => "⏳",
        "success" => "✅",
        "error" => "❌",
        _ => "",  // idle - no indicator
    };
    
    app.tray_handle().set_title(indicator).ok();
}

// Internal sound player (called from Rust)
fn play_sound_internal(sound: &str) {
    let sound_path = match sound {
        "start" => "/System/Library/Sounds/Pop.aiff",
        "stop" => "/System/Library/Sounds/Tink.aiff", 
        "success" => "/System/Library/Sounds/Glass.aiff",
        "error" => "/System/Library/Sounds/Basso.aiff",
        "cancel" => "/System/Library/Sounds/Funk.aiff",
        "pause" => "/System/Library/Sounds/Morse.aiff",
        _ => "/System/Library/Sounds/Pop.aiff",
    };
    
    let path = sound_path.to_string();
    std::thread::spawn(move || {
        Command::new("afplay")
            .arg(path)
            .output()
            .ok();
    });
}

// Play macOS system sounds (called from frontend)
#[tauri::command]
fn play_sound(sound: String) {
    play_sound_internal(&sound);
}

#[tauri::command]
fn get_api_key() -> String {
    load_config().api_key.unwrap_or_default()
}

#[tauri::command]
fn set_api_key(api_key: String) {
    let mut config = load_config();
    config.api_key = Some(api_key);
    save_config(&config);
}

#[tauri::command]
fn register_escape_hotkey(app: tauri::AppHandle) -> Result<(), String> {
    let handle = app.clone();
    app.global_shortcut_manager()
        .register("Escape", move || {
            if let Some(window) = handle.get_window("main") {
                window.emit("cancel-recording", ()).ok();
            }
        })
        .map_err(|e| format!("Failed to register escape: {}", e))
}

#[tauri::command]
fn unregister_escape_hotkey(app: tauri::AppHandle) -> Result<(), String> {
    app.global_shortcut_manager()
        .unregister("Escape")
        .map_err(|e| format!("Failed to unregister escape: {}", e))
}

#[tauri::command]
fn start_recording(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<RecordingState>>,
) -> Result<(), String> {
    if state.is_active() {
        return Err("Already recording".into());
    }

    state.start();

    // Show red dot in menu bar when recording
    app.tray_handle().set_title("🔴").ok();

    // Play start sound
    play_sound_internal("start");

    let state_clone = Arc::clone(&state.inner());

    std::thread::spawn(move || {
        let host = cpal::default_host();
        let device = host
            .default_input_device()
            .expect("No input device available");

        let config = device
            .default_input_config()
            .expect("Failed to get default input config");

        *state_clone.sample_rate.lock() = config.sample_rate().0;

        let state_for_callback = Arc::clone(&state_clone);

        let stream = match config.sample_format() {
            cpal::SampleFormat::F32 => device
                .build_input_stream(
                    &config.into(),
                    move |data: &[f32], _: &cpal::InputCallbackInfo| {
                        state_for_callback.push_samples(data);
                    },
                    |err| eprintln!("Stream error: {}", err),
                    None,
                )
                .expect("Failed to build input stream"),
            cpal::SampleFormat::I16 => device
                .build_input_stream(
                    &config.into(),
                    move |data: &[i16], _: &cpal::InputCallbackInfo| {
                        let float_data: Vec<f32> = data
                            .iter()
                            .map(|&s| s as f32 / i16::MAX as f32)
                            .collect();
                        state_for_callback.push_samples(&float_data);
                    },
                    |err| eprintln!("Stream error: {}", err),
                    None,
                )
                .expect("Failed to build input stream"),
            _ => panic!("Unsupported sample format"),
        };

        stream.play().expect("Failed to start recording");

        // Keep recording until stopped
        while state_clone.is_active() {
            std::thread::sleep(std::time::Duration::from_millis(10));
        }

        drop(stream);
    });

    Ok(())
}

#[tauri::command]
fn get_audio_level(state: tauri::State<'_, Arc<RecordingState>>) -> f32 {
    state.get_audio_level()
}

#[tauri::command]
fn stop_recording(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<RecordingState>>,
) -> Result<String, String> {
    let samples = state.stop();

    // Remove red dot from menu bar
    app.tray_handle().set_title("").ok();

    // Play stop sound
    play_sound_internal("stop");

    // Small delay to ensure stream is fully stopped
    std::thread::sleep(std::time::Duration::from_millis(100));

    let sample_rate = *state.sample_rate.lock();

    if samples.is_empty() {
        return Err("No audio recorded".into());
    }

    // Check if audio is silent (likely microphone permission issue)
    let sum: f32 = samples.iter().map(|s| s * s).sum();
    let rms = (sum / samples.len() as f32).sqrt();
    if rms < 0.001 {
        return Err("No audio detected. Please check microphone permissions in System Settings → Privacy & Security → Microphone".into());
    }

    // Generate filename with timestamp
    let timestamp = chrono::Local::now().format("%Y%m%d_%H%M%S");
    let filename = format!("{}.wav", timestamp);
    let filepath = get_transcripts_dir().join(&filename);

    // Write WAV file
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };

    let file = File::create(&filepath).map_err(|e| e.to_string())?;
    let mut writer = hound::WavWriter::new(BufWriter::new(file), spec).map_err(|e| e.to_string())?;

    for sample in &samples {
        let amplitude = (sample * i16::MAX as f32) as i16;
        writer.write_sample(amplitude).map_err(|e| e.to_string())?;
    }

    writer.finalize().map_err(|e| e.to_string())?;

    Ok(filepath.to_string_lossy().to_string())
}

#[tauri::command]
fn cancel_recording(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<RecordingState>>,
) -> Result<(), String> {
    if !state.is_active() {
        return Err("Not recording".into());
    }

    state.cancel();

    // Remove indicator from menu bar
    app.tray_handle().set_title("").ok();

    // Play cancel sound (subtle)
    play_sound_internal("cancel");

    Ok(())
}

#[tauri::command]
fn pause_recording(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<RecordingState>>,
) -> Result<bool, String> {
    if !state.is_active() {
        return Err("Not recording".into());
    }

    let now_paused = state.toggle_pause();

    // Update tray indicator
    if now_paused {
        app.tray_handle().set_title("⏸️").ok();
    } else {
        app.tray_handle().set_title("🔴").ok();
    }

    Ok(now_paused)
}

#[tauri::command]
fn is_paused(state: tauri::State<'_, Arc<RecordingState>>) -> bool {
    state.is_paused()
}

#[tauri::command]
async fn transcribe(
    audio_path: String,
    api_key: String,
    prompt: Option<String>,
) -> Result<String, String> {
    let client = reqwest::Client::new();

    // Read the audio file
    let audio_data = tokio::fs::read(&audio_path)
        .await
        .map_err(|e| format!("Failed to read audio file: {}", e))?;

    let file_name = std::path::Path::new(&audio_path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("audio.wav")
        .to_string();

    // Create multipart form
    let part = reqwest::multipart::Part::bytes(audio_data)
        .file_name(file_name)
        .mime_str("audio/wav")
        .map_err(|e| e.to_string())?;

    // Use whisper-1: pure transcription, no AI interpretation/responses
    // gpt-4o-mini-transcribe can "respond" instead of transcribe
    let mut form = reqwest::multipart::Form::new()
        .text("model", "whisper-1")
        .text("response_format", "text")
        .part("file", part);

    // Add prompt for technical term recognition (e.g., code terms, proper nouns)
    if let Some(p) = prompt {
        if !p.is_empty() {
            form = form.text("prompt", p);
        }
    }

    // Send to OpenAI
    let response = client
        .post("https://api.openai.com/v1/audio/transcriptions")
        .header("Authorization", format!("Bearer {}", api_key))
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("API request failed: {}", e))?;

    if !response.status().is_success() {
        let error_text = response.text().await.unwrap_or_default();
        return Err(format!("OpenAI API error: {}", error_text));
    }

    let transcript = response
        .text()
        .await
        .map_err(|e| format!("Failed to read response: {}", e))?;

    Ok(transcript.trim().to_string())
}

fn main() {
    let tray_menu = SystemTrayMenu::new()
        .add_item(CustomMenuItem::new("show", "Show Scribe"))
        .add_native_item(SystemTrayMenuItem::Separator)
        .add_item(CustomMenuItem::new("quit", "Quit"));

    let system_tray = SystemTray::new().with_menu(tray_menu);

    let recording_state = Arc::new(RecordingState::default());

    tauri::Builder::default()
        .manage(recording_state)
        .system_tray(system_tray)
        .setup(|app| {
            // Register global shortcut from Rust (more reliable than JS)
            let handle = app.handle();
            app.global_shortcut_manager()
                .register("CommandOrControl+Shift+Space", move || {
                    if let Some(window) = handle.get_window("main") {
                        // Just emit event - don't show window (user wants it hidden)
                        window.emit("toggle-recording", ()).ok();
                    }
                })
                .expect("Failed to register global shortcut");
            
Ok(())
        })
        .on_system_tray_event(|app, event| match event {
            SystemTrayEvent::LeftClick { .. } => {
                if let Some(window) = app.get_window("main") {
                    if window.is_visible().unwrap_or(false) {
                        window.hide().ok();
                    } else {
                        window.show().ok();
                        window.set_focus().ok();
                    }
                }
            }
            SystemTrayEvent::MenuItemClick { id, .. } => match id.as_str() {
                "show" => {
                    if let Some(window) = app.get_window("main") {
                        window.show().ok();
                        window.set_focus().ok();
                    }
                }
                "quit" => {
                    std::process::exit(0);
                }
                _ => {}
            },
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            get_api_key,
            set_api_key,
            register_escape_hotkey,
            unregister_escape_hotkey,
            start_recording,
            stop_recording,
            cancel_recording,
            pause_recording,
            is_paused,
            get_audio_level,
            transcribe,
            play_sound,
            set_tray_status
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
