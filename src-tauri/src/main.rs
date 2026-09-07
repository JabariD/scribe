// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod realtime;
mod recording;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use recording::RecordingState;
use security_framework::os::macos::keychain::SecKeychain;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::fs::{self, File};
use std::io::BufWriter;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{mpsc, Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};
use tauri::{
    CustomMenuItem, GlobalShortcutManager, Manager, SystemTray, SystemTrayEvent, SystemTrayMenu,
    SystemTrayMenuItem,
};

#[derive(Debug, Serialize, Deserialize, Default)]
struct Config {
    api_key: Option<String>, // legacy; migrated to macOS Keychain on read
    show_recording_overlay: Option<bool>,
    realtime_transcription_enabled: Option<bool>,
    prompt: Option<String>,
    post_process_enabled: Option<bool>,
    post_process_prompt: Option<String>,
}

#[derive(Serialize)]
struct TranscriptionResult {
    transcript: String,
    post_process_applied: bool,
    post_process_error: Option<String>,
}

#[derive(Serialize, Default)]
struct RecordingPruneResult {
    deleted_count: u64,
    freed_bytes: u64,
    failed_count: u64,
}

#[derive(Deserialize)]
struct FileTranscriptionResponse {
    text: String,
}

#[derive(Default)]
struct LiveTranscriptionState {
    result: tokio::sync::Mutex<Option<tokio::sync::oneshot::Receiver<Result<String, String>>>>,
}

const KEYCHAIN_SERVICE: &str = "com.scribe.app";
const KEYCHAIN_ACCOUNT_OPENAI_API_KEY: &str = "openai-api-key";
const POST_PROCESS_MODEL: &str = "gpt-4o-mini";
const TRANSCRIPTION_LANGUAGE: &str = "en";
const DEFAULT_POST_PROCESS_PROMPT: &str = "Clean up this voice transcript. Remove filler words like um, uh, ah, and you know. Fix punctuation, capitalization, spelling, and grammar. Preserve the speaker's meaning, wording, tone, and formatting as much as possible. Return only the cleaned transcript.";
// Keep mono PCM16 WAV uploads below the Transcriptions API's 25 MB limit.
const MAX_TRANSCRIPTION_FILE_BYTES: u64 = 24_000_000;
const WAV_BYTES_PER_SAMPLE: u64 = 2;
const API_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const API_REQUEST_TIMEOUT: Duration = Duration::from_secs(180);
static CONFIG_IO_LOCK: StdMutex<()> = StdMutex::new(());

fn max_recording_duration(sample_rate: u32) -> Duration {
    let bytes_per_second = u64::from(sample_rate).saturating_mul(WAV_BYTES_PER_SAMPLE);
    let seconds = MAX_TRANSCRIPTION_FILE_BYTES
        .checked_div(bytes_per_second)
        .unwrap_or(0)
        .max(1);
    Duration::from_secs(seconds)
}

fn api_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(API_CONNECT_TIMEOUT)
        .timeout(API_REQUEST_TIMEOUT)
        .build()
        .map_err(|error| format!("Failed to configure OpenAI client: {error}"))
}

fn get_config_path() -> Result<PathBuf, String> {
    let config_dir = dirs::config_dir()
        .ok_or_else(|| "Could not locate the macOS Application Support directory".to_string())?
        .join("scribe");
    fs::create_dir_all(&config_dir)
        .map_err(|error| format!("Failed to create config directory: {error}"))?;
    Ok(config_dir.join("config.json"))
}

fn load_config_from(path: &Path) -> Result<Config, String> {
    if !path.exists() {
        return Ok(Config::default());
    }

    let contents =
        fs::read_to_string(path).map_err(|error| format!("Failed to read config: {error}"))?;
    serde_json::from_str(&contents).map_err(|error| format!("Failed to parse config: {error}"))
}

fn load_config() -> Result<Config, String> {
    let _guard = CONFIG_IO_LOCK
        .lock()
        .map_err(|_| "Config lock was poisoned".to_string())?;
    load_config_from(&get_config_path()?)
}

fn save_config_to(path: &Path, config: &Config) -> Result<(), String> {
    let json = serde_json::to_string_pretty(config)
        .map_err(|error| format!("Failed to encode config: {error}"))?;
    let temporary_path = path.with_extension("json.tmp");
    fs::write(&temporary_path, json).map_err(|error| format!("Failed to write config: {error}"))?;
    fs::rename(&temporary_path, path).map_err(|error| format!("Failed to replace config: {error}"))
}

fn update_config(update: impl FnOnce(&mut Config)) -> Result<(), String> {
    let _guard = CONFIG_IO_LOCK
        .lock()
        .map_err(|_| "Config lock was poisoned".to_string())?;
    let path = get_config_path()?;
    let mut config = load_config_from(&path)?;
    update(&mut config);
    save_config_to(&path, &config)
}

fn get_transcripts_dir() -> Result<PathBuf, String> {
    let dir = dirs::home_dir()
        .ok_or_else(|| "Could not locate the macOS home directory".to_string())?
        .join("Library")
        .join("VoiceTranscripts");
    fs::create_dir_all(&dir)
        .map_err(|error| format!("Failed to create recordings directory: {error}"))?;
    Ok(dir)
}

fn recording_timestamp(path: &Path) -> Option<chrono::NaiveDateTime> {
    let stem = path.file_stem()?.to_str()?;
    chrono::NaiveDateTime::parse_from_str(stem, "%Y%m%d_%H%M%S").ok()
}

fn prune_recordings_in(
    directory: &Path,
    retention_days: u32,
    now: chrono::NaiveDateTime,
) -> Result<RecordingPruneResult, String> {
    let mut result = RecordingPruneResult::default();
    if retention_days == 0 {
        return Ok(result);
    }

    let cutoff = now - chrono::Duration::days(i64::from(retention_days));
    let entries = fs::read_dir(directory)
        .map_err(|error| format!("Failed to read recordings directory: {error}"))?;

    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => {
                result.failed_count += 1;
                continue;
            }
        };
        let path = entry.path();
        if path.extension().and_then(|extension| extension.to_str()) != Some("wav") {
            continue;
        }
        let Some(timestamp) = recording_timestamp(&path) else {
            continue;
        };
        if timestamp >= cutoff {
            continue;
        }

        let bytes = entry.metadata().map(|metadata| metadata.len()).unwrap_or(0);
        match fs::remove_file(&path) {
            Ok(()) => {
                result.deleted_count += 1;
                result.freed_bytes = result.freed_bytes.saturating_add(bytes);
            }
            Err(_) => result.failed_count += 1,
        }
    }

    Ok(result)
}

#[tauri::command]
fn prune_recordings(retention_days: u32) -> Result<RecordingPruneResult, String> {
    if retention_days > 3_650 {
        return Err("Recording retention must be between 0 and 3650 days".to_string());
    }

    prune_recordings_in(
        &get_transcripts_dir()?,
        retention_days,
        chrono::Local::now().naive_local(),
    )
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
fn get_api_key() -> Result<String, String> {
    if let Some(api_key) = get_api_key_from_keychain() {
        return Ok(api_key);
    }

    let config = load_config()?;
    let legacy_api_key = config.api_key.unwrap_or_default();
    if !legacy_api_key.is_empty() && set_api_key_in_keychain(&legacy_api_key).is_ok() {
        update_config(|config| config.api_key = None)?;
    }
    Ok(legacy_api_key)
}

#[tauri::command]
fn set_api_key(api_key: String) -> Result<(), String> {
    set_api_key_in_keychain(&api_key)?;

    update_config(|config| config.api_key = None)
}

#[tauri::command]
fn get_show_recording_overlay() -> Result<bool, String> {
    Ok(load_config()?.show_recording_overlay.unwrap_or(true))
}

#[tauri::command]
fn set_show_recording_overlay(show_recording_overlay: bool) -> Result<(), String> {
    update_config(|config| config.show_recording_overlay = Some(show_recording_overlay))
}

#[tauri::command]
fn get_realtime_transcription_enabled() -> Result<bool, String> {
    Ok(load_config()?
        .realtime_transcription_enabled
        .unwrap_or(false))
}

#[tauri::command]
fn set_realtime_transcription_enabled(realtime_transcription_enabled: bool) -> Result<(), String> {
    update_config(|config| {
        config.realtime_transcription_enabled = Some(realtime_transcription_enabled)
    })
}

#[tauri::command]
fn get_prompt() -> Result<String, String> {
    Ok(load_config()?.prompt.unwrap_or_default())
}

#[tauri::command]
fn set_prompt(prompt: String) -> Result<(), String> {
    update_config(|config| config.prompt = Some(prompt))
}

#[tauri::command]
fn get_post_process_enabled() -> Result<bool, String> {
    Ok(load_config()?.post_process_enabled.unwrap_or(false))
}

#[tauri::command]
fn set_post_process_enabled(post_process_enabled: bool) -> Result<(), String> {
    update_config(|config| config.post_process_enabled = Some(post_process_enabled))
}

#[tauri::command]
fn get_post_process_prompt() -> Result<String, String> {
    Ok(load_config()?
        .post_process_prompt
        .unwrap_or_else(|| DEFAULT_POST_PROCESS_PROMPT.to_string()))
}

#[tauri::command]
fn set_post_process_prompt(post_process_prompt: String) -> Result<(), String> {
    update_config(|config| config.post_process_prompt = Some(post_process_prompt))
}

#[tauri::command]
async fn start_live_transcription(
    state: tauri::State<'_, Arc<RecordingState>>,
    live_state: tauri::State<'_, LiveTranscriptionState>,
    api_key: String,
    prompt: String,
) -> Result<u64, String> {
    if !state.is_active() {
        return Err("Start recording before realtime transcription".into());
    }

    let mut current_result = live_state.result.lock().await;
    if current_result.is_some() {
        return Err("Realtime transcription is already active".into());
    }

    let audio = state.start_live_audio();
    let sample_rate = *state.sample_rate.lock();
    let buffered_milliseconds = if sample_rate == 0 {
        0
    } else {
        (audio.initial_samples.len() as u64).saturating_mul(1_000) / u64::from(sample_rate)
    };
    let (result_sender, result_receiver) = tokio::sync::oneshot::channel();
    *current_result = Some(result_receiver);

    tauri::async_runtime::spawn(async move {
        let result = realtime::transcribe_audio_stream(
            api_key,
            prompt,
            sample_rate,
            audio.initial_samples,
            audio.receiver,
        )
        .await;
        let _ = result_sender.send(result);
    });

    Ok(buffered_milliseconds)
}

#[tauri::command]
async fn finish_live_transcription(
    state: tauri::State<'_, Arc<RecordingState>>,
    live_state: tauri::State<'_, LiveTranscriptionState>,
) -> Result<String, String> {
    let result_receiver = live_state
        .result
        .lock()
        .await
        .take()
        .ok_or_else(|| "Realtime transcription is not active".to_string())?;

    let dropped_samples = state.live_audio_dropped_samples();
    if dropped_samples > 0 {
        return Err(format!(
            "Realtime audio stream dropped {dropped_samples} samples; using saved recording"
        ));
    }

    tokio::time::timeout(Duration::from_secs(10), result_receiver)
        .await
        .map_err(|_| "Timed out while finishing realtime transcription".to_string())?
        .map_err(|_| "Realtime transcription ended unexpectedly".to_string())?
}

#[tauri::command]
async fn cancel_live_transcription(
    state: tauri::State<'_, Arc<RecordingState>>,
    live_state: tauri::State<'_, LiveTranscriptionState>,
) -> Result<(), String> {
    state.stop_live_audio();
    live_state.result.lock().await.take();
    Ok(())
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
        let max_duration = max_recording_duration(config.sample_rate().0);

        while state_clone.is_active() {
            if started_at.elapsed() >= max_duration {
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
    let filepath = get_transcripts_dir()?.join(&filename);

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

async fn post_process_transcript(
    client: &reqwest::Client,
    api_key: &str,
    transcript: &str,
    prompt: Option<String>,
) -> Result<String, String> {
    let system_prompt = prompt
        .filter(|p| !p.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_POST_PROCESS_PROMPT.to_string());

    let response = client
        .post("https://api.openai.com/v1/chat/completions")
        .header("Authorization", format!("Bearer {api_key}"))
        .json(&json!({
            "model": POST_PROCESS_MODEL,
            "temperature": 0,
            "messages": [
                {
                    "role": "system",
                    "content": system_prompt
                },
                {
                    "role": "user",
                    "content": format!("Clean this transcript and return only the final text:\n\n{transcript}")
                }
            ]
        }))
        .send()
        .await
        .map_err(|e| format!("Post-process request failed: {e}"))?;

    if !response.status().is_success() {
        let error_text = response.text().await.unwrap_or_default();
        return Err(format!("Post-process API error: {error_text}"));
    }

    let body: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to read post-process response: {e}"))?;

    let cleaned = body["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or("")
        .trim()
        .to_string();

    if cleaned.is_empty() {
        return Err("Post-process returned an empty transcript".to_string());
    }

    Ok(cleaned)
}

#[tauri::command]
async fn transcribe(
    audio_path: String,
    api_key: String,
    prompt: Option<String>,
    post_process_enabled: Option<bool>,
    post_process_prompt: Option<String>,
) -> Result<TranscriptionResult, String> {
    let client = api_client()?;

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

    let mut form = reqwest::multipart::Form::new()
        .text("model", "gpt-transcribe")
        .text("languages[]", TRANSCRIPTION_LANGUAGE)
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
        .json::<FileTranscriptionResponse>()
        .await
        .map_err(|e| format!("Failed to read transcription response: {e}"))?
        .text
        .trim()
        .to_string();

    if !post_process_enabled.unwrap_or(false) {
        return Ok(TranscriptionResult {
            transcript,
            post_process_applied: false,
            post_process_error: None,
        });
    }

    finalize_transcript_internal(&client, &api_key, transcript, post_process_prompt).await
}

async fn finalize_transcript_internal(
    client: &reqwest::Client,
    api_key: &str,
    transcript: String,
    post_process_prompt: Option<String>,
) -> Result<TranscriptionResult, String> {
    match post_process_transcript(client, api_key, &transcript, post_process_prompt).await {
        Ok(cleaned) => Ok(TranscriptionResult {
            transcript: cleaned,
            post_process_applied: true,
            post_process_error: None,
        }),
        Err(error) => Ok(TranscriptionResult {
            transcript,
            post_process_applied: false,
            post_process_error: Some(error),
        }),
    }
}

#[tauri::command]
async fn finalize_live_transcript(
    transcript: String,
    api_key: String,
    post_process_enabled: bool,
    post_process_prompt: Option<String>,
) -> Result<TranscriptionResult, String> {
    if !post_process_enabled {
        return Ok(TranscriptionResult {
            transcript,
            post_process_applied: false,
            post_process_error: None,
        });
    }

    let client = api_client()?;
    finalize_transcript_internal(&client, &api_key, transcript, post_process_prompt).await
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
        .manage(LiveTranscriptionState::default())
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
            get_show_recording_overlay,
            set_show_recording_overlay,
            get_realtime_transcription_enabled,
            set_realtime_transcription_enabled,
            get_prompt,
            set_prompt,
            get_post_process_enabled,
            set_post_process_enabled,
            get_post_process_prompt,
            set_post_process_prompt,
            start_live_transcription,
            finish_live_transcription,
            cancel_live_transcription,
            finalize_live_transcript,
            register_escape_hotkey,
            unregister_escape_hotkey,
            start_recording,
            stop_recording,
            cancel_recording,
            pause_recording,
            is_paused,
            get_audio_level,
            prune_recordings,
            transcribe,
            play_sound,
            set_tray_status
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_TEST_DIRECTORY: AtomicU64 = AtomicU64::new(0);

    fn retention_test_dir() -> PathBuf {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system clock should be after Unix epoch")
            .as_nanos();
        let sequence = NEXT_TEST_DIRECTORY.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!(
            "scribe-test-{}-{unique}-{sequence}",
            std::process::id()
        ))
    }

    #[test]
    fn recording_duration_stays_below_the_upload_limit() {
        let duration = max_recording_duration(48_000);
        assert_eq!(duration, Duration::from_secs(250));
        assert!(duration.as_secs() * 48_000 * WAV_BYTES_PER_SAMPLE < 25_000_000);
    }

    #[test]
    fn recording_retention_deletes_only_expired_scribe_wavs() {
        let directory = retention_test_dir();
        fs::create_dir_all(&directory).expect("create retention test directory");
        let expired = directory.join("20240101_120000.wav");
        let retained = directory.join("20240201_120000.wav");
        let unrelated = directory.join("meeting.wav");
        File::create(&expired).expect("create expired recording");
        File::create(&retained).expect("create retained recording");
        File::create(&unrelated).expect("create unrelated wav");

        let now = chrono::NaiveDateTime::parse_from_str("20240215_120000", "%Y%m%d_%H%M%S")
            .expect("parse test timestamp");
        let result = prune_recordings_in(&directory, 30, now).expect("prune recordings");

        assert_eq!(result.deleted_count, 1);
        assert!(!expired.exists());
        assert!(retained.exists());
        assert!(unrelated.exists());

        fs::remove_dir_all(&directory).expect("remove retention test directory");
    }

    #[test]
    fn zero_retention_days_keeps_recordings() {
        let directory = retention_test_dir();
        fs::create_dir_all(&directory).expect("create retention test directory");
        let recording = directory.join("20200101_120000.wav");
        File::create(&recording).expect("create recording");
        let now = chrono::NaiveDateTime::parse_from_str("20240215_120000", "%Y%m%d_%H%M%S")
            .expect("parse test timestamp");

        let result = prune_recordings_in(&directory, 0, now).expect("prune recordings");

        assert_eq!(result.deleted_count, 0);
        assert!(recording.exists());

        fs::remove_dir_all(&directory).expect("remove retention test directory");
    }

    #[test]
    fn config_save_is_atomic_and_round_trips() {
        let directory = retention_test_dir();
        fs::create_dir_all(&directory).expect("create config test directory");
        let path = directory.join("config.json");
        let config = Config {
            show_recording_overlay: Some(false),
            ..Config::default()
        };

        save_config_to(&path, &config).expect("save config");
        let saved = load_config_from(&path).expect("load config");

        assert_eq!(saved.show_recording_overlay, Some(false));
        assert!(!path.with_extension("json.tmp").exists());

        fs::remove_dir_all(&directory).expect("remove config test directory");
    }

    #[test]
    fn invalid_config_is_reported_instead_of_resetting_to_defaults() {
        let directory = retention_test_dir();
        fs::create_dir_all(&directory).expect("create config test directory");
        let path = directory.join("config.json");
        fs::write(&path, "not json").expect("write invalid config");

        let error = load_config_from(&path).expect_err("invalid config should fail");

        assert!(error.contains("Failed to parse config"));

        fs::remove_dir_all(&directory).expect("remove config test directory");
    }
}
