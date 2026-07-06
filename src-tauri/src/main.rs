// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod recording;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use recording::RecordingState;
use security_framework::os::macos::keychain::SecKeychain;
use serde::{Deserialize, Serialize};
use std::fs::{self, File};
use std::io::BufWriter;
use std::path::PathBuf;
use std::process::Command;
use std::sync::{mpsc, Arc};
use std::time::{Duration, Instant};
use tauri::{
    CustomMenuItem, GlobalShortcutManager, Manager, SystemTray, SystemTrayEvent, SystemTrayMenu,
    SystemTrayMenuItem,
};

#[derive(Serialize, Deserialize, Default)]
struct Config {
    api_key: Option<String>, // legacy; migrated to macOS Keychain on read
    model: Option<String>,
    show_recording_overlay: Option<bool>,
    prompt: Option<String>,
}

const KEYCHAIN_SERVICE: &str = "com.scribe.app";
const KEYCHAIN_ACCOUNT_OPENAI_API_KEY: &str = "openai-api-key";
const MAX_RECORDING_DURATION: Duration = Duration::from_secs(10 * 60);

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

fn get_api_key_from_keychain() -> Option<String> {
    let keychain = SecKeychain::default().ok()?;
    let (password, _) = keychain
        .find_generic_password(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT_OPENAI_API_KEY)
        .ok()?;
    String::from_utf8(password.as_ref().to_vec()).ok()
}

fn set_api_key_in_keychain(api_key: &str) -> Result<(), String> {
    let keychain = SecKeychain::default().map_err(|e| e.to_string())?;

    if api_key.trim().is_empty() {
        if let Ok((_, item)) =
            keychain.find_generic_password(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT_OPENAI_API_KEY)
        {
            item.delete();
        }
        return Ok(());
    }

    keychain
        .set_generic_password(
            KEYCHAIN_SERVICE,
            KEYCHAIN_ACCOUNT_OPENAI_API_KEY,
            api_key.as_bytes(),
        )
        .map_err(|e| e.to_string())
}

fn push_f32_samples(state: &RecordingState, data: &[f32], channels: usize) {
    if channels <= 1 {
        state.push_samples(data);
        return;
    }

    let mono: Vec<f32> = data
        .chunks(channels)
        .map(|frame| frame.iter().sum::<f32>() / frame.len() as f32)
        .collect();
    state.push_samples(&mono);
}

fn push_i16_samples(state: &RecordingState, data: &[i16], channels: usize) {
    let samples: Vec<f32> = data.iter().map(|&s| s as f32 / i16::MAX as f32).collect();
    push_f32_samples(state, &samples, channels);
}

fn push_u16_samples(state: &RecordingState, data: &[u16], channels: usize) {
    let samples: Vec<f32> = data
        .iter()
        .map(|&s| (s as f32 / u16::MAX as f32) * 2.0 - 1.0)
        .collect();
    push_f32_samples(state, &samples, channels);
}

// Update tray status indicator
#[tauri::command]
fn set_tray_status(app: tauri::AppHandle, status: String) {
    let indicator = match status.as_str() {
        "recording" => "🔴",
        "processing" => "⏳",
        "success" => "✅",
        "error" => "❌",
        _ => "", // idle - no indicator
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
        Command::new("afplay").arg(path).output().ok();
    });
}

// Play macOS system sounds (called from frontend)
#[tauri::command]
fn play_sound(sound: String) {
    play_sound_internal(&sound);
}

#[tauri::command]
fn get_api_key() -> String {
    if let Some(api_key) = get_api_key_from_keychain() {
        return api_key;
    }

    let mut config = load_config();
    let legacy_api_key = config.api_key.take().unwrap_or_default();
    if !legacy_api_key.is_empty() && set_api_key_in_keychain(&legacy_api_key).is_ok() {
        save_config(&config);
    }
    legacy_api_key
}

#[tauri::command]
fn set_api_key(api_key: String) -> Result<(), String> {
    set_api_key_in_keychain(&api_key)?;

    let mut config = load_config();
    config.api_key = None;
    save_config(&config);
    Ok(())
}

#[tauri::command]
fn get_model() -> String {
    load_config()
        .model
        .unwrap_or_else(|| "whisper-1".to_string())
}

#[tauri::command]
fn set_model(model: String) {
    let mut config = load_config();
    config.model = Some(model);
    save_config(&config);
}

#[tauri::command]
fn get_show_recording_overlay() -> bool {
    load_config().show_recording_overlay.unwrap_or(true)
}

#[tauri::command]
fn set_show_recording_overlay(show_recording_overlay: bool) {
    let mut config = load_config();
    config.show_recording_overlay = Some(show_recording_overlay);
    save_config(&config);
}

#[tauri::command]
fn get_prompt() -> String {
    load_config().prompt.unwrap_or_default()
}

#[tauri::command]
fn set_prompt(prompt: String) {
    let mut config = load_config();
    config.prompt = Some(prompt);
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
        .map_err(|e| format!("Failed to register escape: {e}"))
}

#[tauri::command]
fn unregister_escape_hotkey(app: tauri::AppHandle) -> Result<(), String> {
    app.global_shortcut_manager()
        .unregister("Escape")
        .map_err(|e| format!("Failed to unregister escape: {e}"))
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

    let state_clone = Arc::clone(state.inner());
    let handle = app.clone();
    let (ready_tx, ready_rx) = mpsc::channel();

    std::thread::spawn(move || {
        let host = cpal::default_host();
        let Some(device) = host.default_input_device() else {
            state_clone.cancel();
            let _ = ready_tx.send(Err("No input device available".to_string()));
            return;
        };

        let config = match device.default_input_config() {
            Ok(config) => config,
            Err(error) => {
                state_clone.cancel();
                let _ = ready_tx.send(Err(format!("Failed to get default input config: {error}")));
                return;
            }
        };

        *state_clone.sample_rate.lock() = config.sample_rate().0;
        let stream_config: cpal::StreamConfig = config.clone().into();
        let channels = usize::from(stream_config.channels);

        let stream_result = match config.sample_format() {
            cpal::SampleFormat::F32 => {
                let state_for_callback = Arc::clone(&state_clone);
                device.build_input_stream(
                    &stream_config,
                    move |data: &[f32], _: &cpal::InputCallbackInfo| {
                        push_f32_samples(&state_for_callback, data, channels);
                    },
                    |err| eprintln!("Stream error: {err}"),
                    None,
                )
            }
            cpal::SampleFormat::I16 => {
                let state_for_callback = Arc::clone(&state_clone);
                device.build_input_stream(
                    &stream_config,
                    move |data: &[i16], _: &cpal::InputCallbackInfo| {
                        push_i16_samples(&state_for_callback, data, channels);
                    },
                    |err| eprintln!("Stream error: {err}"),
                    None,
                )
            }
            cpal::SampleFormat::U16 => {
                let state_for_callback = Arc::clone(&state_clone);
                device.build_input_stream(
                    &stream_config,
                    move |data: &[u16], _: &cpal::InputCallbackInfo| {
                        push_u16_samples(&state_for_callback, data, channels);
                    },
                    |err| eprintln!("Stream error: {err}"),
                    None,
                )
            }
            sample_format => {
                state_clone.cancel();
                let _ = ready_tx.send(Err(format!(
                    "Unsupported input sample format: {sample_format:?}"
                )));
                return;
            }
        };

        let stream = match stream_result {
            Ok(stream) => stream,
            Err(error) => {
                state_clone.cancel();
                let _ = ready_tx.send(Err(format!("Failed to build input stream: {error}")));
                return;
            }
        };

        if let Err(error) = stream.play() {
            state_clone.cancel();
            let _ = ready_tx.send(Err(format!("Failed to start recording: {error}")));
            return;
        }

        let _ = ready_tx.send(Ok(()));
        let started_at = Instant::now();

        while state_clone.is_active() {
            if started_at.elapsed() >= MAX_RECORDING_DURATION {
                state_clone.stop();
                if let Some(window) = handle.get_window("main") {
                    window.emit("recording-time-limit-reached", ()).ok();
                }
                break;
            }

            std::thread::sleep(Duration::from_millis(10));
        }

        drop(stream);
    });

    match ready_rx.recv_timeout(Duration::from_secs(2)) {
        Ok(Ok(())) => {
            app.tray_handle().set_title("🔴").ok();
            play_sound_internal("start");
            Ok(())
        }
        Ok(Err(error)) => {
            app.tray_handle().set_title("❌").ok();
            Err(error)
        }
        Err(_) => {
            state.cancel();
            app.tray_handle().set_title("❌").ok();
            Err("Timed out while starting microphone input".into())
        }
    }
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
    if !state.has_audio_content() {
        return Err("No audio detected. Please check microphone permissions in System Settings → Privacy & Security → Microphone".into());
    }

    // Generate filename with timestamp
    let timestamp = chrono::Local::now().format("%Y%m%d_%H%M%S");
    let filename = format!("{timestamp}.wav");
    let filepath = get_transcripts_dir().join(&filename);

    // Write WAV file
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };

    let file = File::create(&filepath).map_err(|e| e.to_string())?;
    let mut writer =
        hound::WavWriter::new(BufWriter::new(file), spec).map_err(|e| e.to_string())?;

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
    model: Option<String>,
    prompt: Option<String>,
) -> Result<String, String> {
    let client = reqwest::Client::new();

    // Read the audio file
    let audio_data = tokio::fs::read(&audio_path)
        .await
        .map_err(|e| format!("Failed to read audio file: {e}"))?;

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

    // Validate model — only allow known transcription models
    let selected_model = match model.as_deref().unwrap_or("whisper-1") {
        "gpt-4o-transcribe" => "gpt-4o-transcribe",
        "gpt-4o-mini-transcribe" => "gpt-4o-mini-transcribe",
        _ => "whisper-1",
    };

    let mut form = reqwest::multipart::Form::new()
        .text("model", selected_model)
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
        .header("Authorization", format!("Bearer {api_key}"))
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("API request failed: {e}"))?;

    if !response.status().is_success() {
        let error_text = response.text().await.unwrap_or_default();
        return Err(format!("OpenAI API error: {error_text}"));
    }

    let transcript = response
        .text()
        .await
        .map_err(|e| format!("Failed to read response: {e}"))?;

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
                        window.emit("show-settings", ()).ok();
                        window.show().ok();
                        window.set_focus().ok();
                    }
                }
            }
            SystemTrayEvent::MenuItemClick { id, .. } => match id.as_str() {
                "show" => {
                    if let Some(window) = app.get_window("main") {
                        window.emit("show-settings", ()).ok();
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
            get_model,
            set_model,
            get_show_recording_overlay,
            set_show_recording_overlay,
            get_prompt,
            set_prompt,
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
