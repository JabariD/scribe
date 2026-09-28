//! On-device transcription with NVIDIA Parakeet TDT 0.6B v3 (int8 ONNX).
//!
//! Why this model: it leads Whisper large-v3 on English benchmarks (Open ASR Leaderboard),
//! is faster than Whisper large-v3-turbo on Apple Silicon, is less prone to inventing text
//! during silence, and the int8 build is ~670 MB on disk. Measured on an M3 Pro CPU: 0.66 s
//! to load, ~750 MB peak memory footprint, 27 s of audio in 0.95 s. It does not accept a
//! vocabulary prompt, so vocabulary hints only apply to OpenAI transcription.
//!
//! The model loads when a recording starts (hidden behind the user speaking), transcribes
//! finished chunks while recording continues, and unloads after `IDLE_UNLOAD_AFTER` without
//! use, so the menu bar app does not hold ~750 MB of RAM all day.

use futures_util::StreamExt;
use parking_lot::Mutex;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::Arc;
use std::time::{Duration, Instant};
use transcribe_rs::onnx::parakeet::{ParakeetModel, ParakeetParams};
use transcribe_rs::onnx::Quantization;

use crate::audio;
use crate::recording::RecordingState;

pub const LOCAL_MODEL_NAME: &str = "parakeet-tdt-0.6b-v3";
pub const SAMPLE_RATE: u32 = 16_000;
const MODEL_DIR_NAME: &str = "parakeet-tdt-0.6b-v3-int8";
// Pinned to a commit so the checksums below stay valid.
const MODEL_BASE_URL: &str =
    "https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx/resolve/8f23f0c03c8761650bdb5b40aaf3e40d2c15f1ce";
const IDLE_UNLOAD_AFTER: Duration = Duration::from_secs(10 * 60);
// Parakeet's encoder cost grows faster than linearly with clip length (155 s took 10.6 s,
// 27 s took 0.95 s on an M3 Pro), so long audio is transcribed in chunks split at pauses.
const CHUNK_MAX_SAMPLES: usize = 30 * SAMPLE_RATE as usize;
const CHUNK_SPLIT_SEARCH_SAMPLES: usize = 10 * SAMPLE_RATE as usize;
const SPLIT_FRAME_SAMPLES: usize = SAMPLE_RATE as usize / 10;

struct ModelFile {
    name: &'static str,
    bytes: u64,
    sha256: &'static str,
}

const MODEL_FILES: &[ModelFile] = &[
    ModelFile {
        name: "encoder-model.int8.onnx",
        bytes: 652_183_999,
        sha256: "6139d2fa7e1b086097b277c7149725edbab89cc7c7ae64b23c741be4055aff09",
    },
    ModelFile {
        name: "decoder_joint-model.int8.onnx",
        bytes: 18_202_004,
        sha256: "eea7483ee3d1a30375daedc8ed83e3960c91b098812127a0d99d1c8977667a70",
    },
    ModelFile {
        name: "nemo128.onnx",
        bytes: 139_764,
        sha256: "a9fde1486ebfcc08f328d75ad4610c67835fea58c73ba57e3209a6f6cf019e9f",
    },
    ModelFile {
        name: "vocab.txt",
        bytes: 93_939,
        sha256: "d58544679ea4bc6ac563d1f545eb7d474bd6cfa467f0a6e2c1dc1c7d37e3c35d",
    },
];

#[derive(Serialize, Clone)]
pub struct LocalModelStatus {
    pub name: &'static str,
    pub installed: bool,
    pub downloading: bool,
    pub total_bytes: u64,
}

#[derive(Serialize, Clone)]
pub struct DownloadProgress {
    pub downloaded_bytes: u64,
    pub total_bytes: u64,
}

struct LoadedModel {
    model: ParakeetModel,
    last_used: Instant,
}

pub struct LocalEngine {
    model: Arc<ModelSlot>,
    downloading: AtomicBool,
    session: Mutex<Option<LiveSession>>,
}

/// The on-disk model and, while in use, its loaded copy. One lock serializes loading,
/// transcription, and idle unload.
struct ModelSlot {
    directory: PathBuf,
    loaded: Mutex<Option<LoadedModel>>,
}

/// Transcribes completed chunks while the user is still speaking, so stopping only waits
/// for the final partial chunk.
struct LiveSession {
    finish: mpsc::Sender<()>,
    result: mpsc::Receiver<Result<String, String>>,
}

const LIVE_POLL_INTERVAL: Duration = Duration::from_millis(500);

fn total_model_bytes() -> u64 {
    MODEL_FILES.iter().map(|file| file.bytes).sum()
}

pub fn default_model_dir() -> Option<PathBuf> {
    Some(
        dirs::config_dir()?
            .join("scribe")
            .join("models")
            .join(MODEL_DIR_NAME),
    )
}

/// Cheap presence check (sizes only); checksums are verified once, at download time.
fn is_installed_in(directory: &Path) -> bool {
    MODEL_FILES.iter().all(|file| {
        fs::metadata(directory.join(file.name))
            .map(|metadata| metadata.len() == file.bytes)
            .unwrap_or(false)
    })
}

impl LocalEngine {
    pub fn new(directory: PathBuf) -> Self {
        Self {
            model: Arc::new(ModelSlot {
                directory,
                loaded: Mutex::new(None),
            }),
            downloading: AtomicBool::new(false),
            session: Mutex::new(None),
        }
    }

    pub fn status(&self) -> Result<LocalModelStatus, String> {
        Ok(LocalModelStatus {
            name: LOCAL_MODEL_NAME,
            installed: is_installed_in(&self.model.directory),
            downloading: self.downloading.load(Ordering::SeqCst),
            total_bytes: total_model_bytes(),
        })
    }

    /// Downloads missing model files, verifying each checksum before it becomes visible.
    pub async fn download(
        &self,
        client: &reqwest::Client,
        on_progress: impl Fn(u64, u64),
    ) -> Result<(), String> {
        if self.downloading.swap(true, Ordering::SeqCst) {
            return Err("The local model is already downloading".into());
        }
        let result = download_into(client, &self.model.directory, &on_progress).await;
        self.downloading.store(false, Ordering::SeqCst);
        result
    }

    /// Transcribes a saved recording of any length.
    pub fn transcribe_file(&self, path: &Path) -> Result<String, String> {
        let samples = audio::read_wav_mono_16k(path)?;
        non_empty(transcribe_chunked(&samples, |chunk| {
            transcribe_samples(&self.model, chunk)
        })?)
    }

    /// Starts transcribing the active recording in the background. Dropping or replacing the
    /// session cancels it: the worker exits at its next poll when the finish channel closes.
    pub fn start_session(&self, recording: Arc<RecordingState>) {
        let (finish_sender, finish_receiver) = mpsc::channel();
        let (result_sender, result_receiver) = mpsc::channel();
        let slot = Arc::clone(&self.model);
        std::thread::spawn(move || {
            let result = run_live_session(&slot, &recording, &finish_receiver);
            let _ = result_sender.send(result);
        });
        *self.session.lock() = Some(LiveSession {
            finish: finish_sender,
            result: result_receiver,
        });
    }

    /// Blocks until the session transcribes the remaining audio. Call after recording stops.
    pub fn finish_session(&self) -> Result<String, String> {
        let session = self
            .session
            .lock()
            .take()
            .ok_or_else(|| "Local transcription is not active".to_string())?;
        session
            .finish
            .send(())
            .map_err(|_| "Local transcription ended unexpectedly".to_string())?;
        session
            .result
            .recv()
            .map_err(|_| "Local transcription ended unexpectedly".to_string())?
            .and_then(non_empty)
    }

    pub fn cancel_session(&self) {
        self.session.lock().take();
    }

    /// Starts a background thread that frees the model after it sits idle.
    pub fn start_idle_unloader(&self) {
        let slot = Arc::clone(&self.model);
        std::thread::spawn(move || loop {
            std::thread::sleep(Duration::from_secs(60));
            let mut guard = slot.loaded.lock();
            if guard
                .as_ref()
                .is_some_and(|loaded| loaded.last_used.elapsed() >= IDLE_UNLOAD_AFTER)
            {
                *guard = None;
            }
        });
    }
}

fn run_live_session(
    slot: &ModelSlot,
    recording: &RecordingState,
    finish: &mpsc::Receiver<()>,
) -> Result<String, String> {
    // Loading here overlaps model start-up with the user speaking.
    with_model(slot, |_| Ok(()))?;

    let source_rate = *recording.sample_rate.lock();
    let mut consumed = 0;
    let mut pending: Vec<f32> = Vec::new();
    let mut parts = Vec::new();
    loop {
        let finishing = match finish.recv_timeout(LIVE_POLL_INTERVAL) {
            Ok(()) => true,
            Err(RecvTimeoutError::Timeout) => false,
            Err(RecvTimeoutError::Disconnected) => {
                return Err("Local transcription canceled".into())
            }
        };

        {
            let samples = recording.samples.lock();
            if samples.len() < consumed {
                return Err("Recording restarted during local transcription".into());
            }
            pending.extend(audio::resample(
                &samples[consumed..],
                source_rate,
                SAMPLE_RATE,
            ));
            consumed = samples.len();
        }

        if finishing {
            parts.push(transcribe_chunked(&pending, |chunk| {
                transcribe_samples(slot, chunk)
            })?);
            return Ok(join_parts(&parts));
        }
        while let Some(split) = chunk_split_point(&pending) {
            parts.push(transcribe_samples(slot, &pending[..split])?);
            pending.drain(..split);
        }
    }
}

fn transcribe_samples(slot: &ModelSlot, samples: &[f32]) -> Result<String, String> {
    if samples.is_empty() {
        return Ok(String::new());
    }
    with_model(slot, |model| {
        model
            .transcribe_with(samples, &ParakeetParams::default())
            .map(|result| result.text)
            .map_err(|error| format!("Local transcription failed: {error}"))
    })
}

fn non_empty(text: String) -> Result<String, String> {
    let text = text.trim().to_string();
    if text.is_empty() {
        return Err("Local transcription returned no text".into());
    }
    Ok(text)
}

fn with_model<T>(
    slot: &ModelSlot,
    run: impl FnOnce(&mut ParakeetModel) -> Result<T, String>,
) -> Result<T, String> {
    let mut guard = slot.loaded.lock();
    if guard.is_none() {
        if !is_installed_in(&slot.directory) {
            return Err("The local model is not downloaded. Download it in Settings.".into());
        }
        let model = ParakeetModel::load(&slot.directory, &Quantization::Int8)
            .map_err(|error| format!("Failed to load local model: {error}"))?;
        *guard = Some(LoadedModel {
            model,
            last_used: Instant::now(),
        });
    }
    let loaded = guard.as_mut().expect("model was loaded above");
    loaded.last_used = Instant::now();
    run(&mut loaded.model)
}

/// Returns where to cut `samples` so the first chunk ends at the quietest 100 ms frame in the
/// last `CHUNK_SPLIT_SEARCH_SAMPLES` of a full chunk, or `None` if a full chunk is not buffered.
pub fn chunk_split_point(samples: &[f32]) -> Option<usize> {
    if samples.len() < CHUNK_MAX_SAMPLES {
        return None;
    }
    let search_start = CHUNK_MAX_SAMPLES - CHUNK_SPLIT_SEARCH_SAMPLES;
    (search_start..CHUNK_MAX_SAMPLES - SPLIT_FRAME_SAMPLES)
        .step_by(SPLIT_FRAME_SAMPLES / 2)
        .min_by(|&a, &b| {
            frame_energy(&samples[a..a + SPLIT_FRAME_SAMPLES])
                .total_cmp(&frame_energy(&samples[b..b + SPLIT_FRAME_SAMPLES]))
        })
        .map(|start| start + SPLIT_FRAME_SAMPLES / 2)
}

fn frame_energy(frame: &[f32]) -> f32 {
    frame.iter().map(|sample| sample * sample).sum()
}

/// Transcribes arbitrarily long audio as pause-aligned chunks joined with spaces.
pub fn transcribe_chunked(
    samples: &[f32],
    mut transcribe_chunk: impl FnMut(&[f32]) -> Result<String, String>,
) -> Result<String, String> {
    let mut parts = Vec::new();
    let mut rest = samples;
    while let Some(split) = chunk_split_point(rest) {
        parts.push(transcribe_chunk(&rest[..split])?);
        rest = &rest[split..];
    }
    parts.push(transcribe_chunk(rest)?);
    Ok(join_parts(&parts))
}

fn join_parts(parts: &[String]) -> String {
    parts
        .iter()
        .map(|part| part.trim())
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

async fn download_into(
    client: &reqwest::Client,
    directory: &Path,
    on_progress: &impl Fn(u64, u64),
) -> Result<(), String> {
    fs::create_dir_all(directory)
        .map_err(|error| format!("Failed to create model directory: {error}"))?;
    let total = total_model_bytes();
    let mut done: u64 = 0;

    for file in MODEL_FILES {
        let destination = directory.join(file.name);
        if fs::metadata(&destination).is_ok_and(|metadata| metadata.len() == file.bytes) {
            done += file.bytes;
            on_progress(done, total);
            continue;
        }

        let response = client
            .get(format!("{MODEL_BASE_URL}/{}", file.name))
            .timeout(Duration::from_secs(60 * 60))
            .send()
            .await
            .and_then(|response| response.error_for_status())
            .map_err(|error| format!("Failed to download {}: {error}", file.name))?;

        let partial = destination.with_extension("part");
        let mut writer = std::io::BufWriter::new(
            fs::File::create(&partial)
                .map_err(|error| format!("Failed to create {}: {error}", file.name))?,
        );
        let mut hasher = Sha256::new();
        let mut stream = response.bytes_stream();
        let mut last_report = Instant::now();
        while let Some(chunk) = stream.next().await {
            let chunk =
                chunk.map_err(|error| format!("Download of {} failed: {error}", file.name))?;
            hasher.update(&chunk);
            writer
                .write_all(&chunk)
                .map_err(|error| format!("Failed to write {}: {error}", file.name))?;
            done += chunk.len() as u64;
            if last_report.elapsed() >= Duration::from_millis(200) {
                on_progress(done, total);
                last_report = Instant::now();
            }
        }
        writer
            .flush()
            .map_err(|error| format!("Failed to write {}: {error}", file.name))?;
        drop(writer);

        let digest = format!("{:x}", hasher.finalize());
        if digest != file.sha256 {
            fs::remove_file(&partial).ok();
            return Err(format!(
                "Checksum mismatch for {}; the download was discarded",
                file.name
            ));
        }
        fs::rename(&partial, &destination)
            .map_err(|error| format!("Failed to install {}: {error}", file.name))?;
        on_progress(done, total);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_or_truncated_files_are_not_installed() {
        let directory = std::env::temp_dir().join(format!(
            "scribe-local-model-test-{}-{}",
            std::process::id(),
            Instant::now().elapsed().as_nanos()
        ));
        fs::create_dir_all(&directory).unwrap();
        assert!(!is_installed_in(&directory));

        fs::write(directory.join("nemo128.onnx"), b"truncated").unwrap();
        assert!(!is_installed_in(&directory));

        fs::remove_dir_all(&directory).unwrap();
    }

    /// Benchmark against a real model and WAV:
    /// SCRIBE_BENCH_MODEL_DIR=... SCRIBE_BENCH_WAV=... cargo test --release bench_local -- --ignored --nocapture
    #[test]
    #[ignore]
    fn bench_local_transcription() {
        let model_dir = PathBuf::from(std::env::var("SCRIBE_BENCH_MODEL_DIR").unwrap());
        let wavs = std::env::var("SCRIBE_BENCH_WAV").unwrap();

        let started = Instant::now();
        let mut model = ParakeetModel::load(&model_dir, &Quantization::Int8).unwrap();
        println!("load: {:?}", started.elapsed());

        for wav in wavs.split(',') {
            let samples = crate::audio::read_wav_mono_16k(Path::new(wav)).unwrap();
            let seconds = samples.len() as f32 / SAMPLE_RATE as f32;
            let started = Instant::now();
            let whole = model
                .transcribe_with(&samples, &ParakeetParams::default())
                .unwrap()
                .text;
            let whole_elapsed = started.elapsed();
            let started = Instant::now();
            let chunked = transcribe_chunked(&samples, |chunk| {
                Ok(model
                    .transcribe_with(chunk, &ParakeetParams::default())
                    .unwrap()
                    .text)
            })
            .unwrap();
            let chunked_elapsed = started.elapsed();
            println!("{seconds:.1}s audio: whole {whole_elapsed:?}, chunked {chunked_elapsed:?}");
            println!("  whole:   {whole}");
            println!("  chunked: {chunked}");
        }
    }

    #[test]
    fn chunks_split_at_the_quietest_pause_before_the_limit() {
        let rate = SAMPLE_RATE as usize;
        assert_eq!(chunk_split_point(&vec![0.5; 29 * rate]), None);

        let mut samples: Vec<f32> = (0..40 * rate)
            .map(|i| if i % 2 == 0 { 0.5 } else { -0.5 })
            .collect();
        samples[25 * rate..25 * rate + rate / 4].fill(0.0);
        let split = chunk_split_point(&samples).unwrap();
        assert!(
            (25 * rate..25 * rate + rate / 4).contains(&split),
            "split at {split}"
        );
    }

    #[test]
    fn chunked_transcription_covers_all_audio_in_bounded_chunks() {
        let samples = vec![0.1; 75 * SAMPLE_RATE as usize];
        let mut chunk_lengths = Vec::new();
        let text = transcribe_chunked(&samples, |chunk| {
            chunk_lengths.push(chunk.len());
            Ok(format!("part{}", chunk_lengths.len()))
        })
        .unwrap();
        assert_eq!(chunk_lengths.iter().sum::<usize>(), samples.len());
        assert!(chunk_lengths
            .iter()
            .all(|&length| length <= CHUNK_MAX_SAMPLES));
        assert_eq!(
            text,
            (1..=chunk_lengths.len())
                .map(|i| format!("part{i}"))
                .collect::<Vec<_>>()
                .join(" ")
        );
    }

    fn bench_model_dir() -> PathBuf {
        PathBuf::from(std::env::var("SCRIBE_BENCH_MODEL_DIR").expect("SCRIBE_BENCH_MODEL_DIR"))
    }

    /// Feeds a WAV through a live session at 5x speed and reports the wait after "stop":
    /// SCRIBE_BENCH_MODEL_DIR=... SCRIBE_BENCH_WAV=... cargo test --release live_session -- --ignored --nocapture
    #[test]
    #[ignore]
    fn live_session_transcribes_while_recording() {
        let engine = LocalEngine::new(bench_model_dir());
        for wav in std::env::var("SCRIBE_BENCH_WAV").unwrap().split(',') {
            let mut reader = hound::WavReader::open(wav).unwrap();
            let rate = reader.spec().sample_rate;
            let samples: Vec<f32> = reader
                .samples::<i16>()
                .map(|sample| sample.unwrap() as f32 / i16::MAX as f32)
                .collect();

            let recording = Arc::new(RecordingState::default());
            *recording.sample_rate.lock() = rate;
            recording.start();
            engine.start_session(Arc::clone(&recording));
            for block in samples.chunks(rate as usize / 10) {
                recording.push_samples(block);
                std::thread::sleep(Duration::from_millis(20));
            }
            recording.stop();

            let started = Instant::now();
            let text = engine.finish_session().unwrap();
            println!(
                "{:.1}s audio: {:?} after stop: {}",
                samples.len() as f32 / rate as f32,
                started.elapsed(),
                text.chars().take(80).collect::<String>()
            );
        }
    }

    /// Downloads the small model files for real (the encoder is linked from
    /// SCRIBE_BENCH_MODEL_DIR to skip 650 MB) and checks they verify and install.
    #[test]
    #[ignore]
    fn download_verifies_and_installs_files() {
        let directory =
            std::env::temp_dir().join(format!("scribe-download-test-{}", std::process::id()));
        fs::create_dir_all(&directory).unwrap();
        fs::hard_link(
            bench_model_dir().join("encoder-model.int8.onnx"),
            directory.join("encoder-model.int8.onnx"),
        )
        .unwrap();

        let engine = LocalEngine::new(directory.clone());
        assert!(!engine.status().unwrap().installed);
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let last_progress = std::sync::Mutex::new((0, 0));
        runtime
            .block_on(engine.download(&reqwest::Client::new(), |done, total| {
                *last_progress.lock().unwrap() = (done, total);
            }))
            .unwrap();

        assert!(engine.status().unwrap().installed);
        assert_eq!(
            *last_progress.lock().unwrap(),
            (total_model_bytes(), total_model_bytes())
        );
        fs::remove_dir_all(&directory).unwrap();
    }
}
