use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::sync::mpsc::{Receiver, TryRecvError};
use std::time::Duration;
use tokio_tungstenite::tungstenite::{client::IntoClientRequest, Message};

const REALTIME_URL: &str = "wss://api.openai.com/v1/realtime?intent=transcription";
const TARGET_SAMPLE_RATE: u32 = 24_000;
const TRANSCRIPTION_LANGUAGE: &str = "en";

/// Streams microphone chunks to OpenAI and returns the final transcript when the producer closes.
pub async fn transcribe_audio_stream(
    api_key: String,
    model: String,
    prompt: String,
    source_sample_rate: u32,
    audio: Receiver<Vec<f32>>,
) -> Result<String, String> {
    let mut request = REALTIME_URL
        .into_client_request()
        .map_err(|error| format!("Invalid realtime API request: {error}"))?;
    request.headers_mut().insert(
        "Authorization",
        format!("Bearer {api_key}")
            .parse()
            .map_err(|error| format!("Invalid API key header: {error}"))?,
    );

    let (socket, _) = tokio_tungstenite::connect_async(request)
        .await
        .map_err(|error| format!("Realtime API connection failed: {error}"))?;
    let (mut writer, mut reader) = socket.split();

    let transcription = transcription_settings(&model, &prompt);

    writer
        .send(Message::Text(
            json!({
                "type": "session.update",
                "session": {
                    "type": "transcription",
                    "audio": {
                        "input": {
                            "format": { "type": "audio/pcm", "rate": TARGET_SAMPLE_RATE },
                            "transcription": transcription,
                            "turn_detection": {
                                "type": "server_vad",
                                "silence_duration_ms": 500
                            }
                        }
                    }
                }
            })
            .to_string(),
        ))
        .await
        .map_err(|error| format!("Failed to configure realtime transcription: {error}"))?;

    let mut completed_transcript = String::new();
    let mut current_delta = String::new();
    let mut producer_closed = false;
    let mut commit_sent = false;
    let mut finish_deadline = None;
    let mut interval = tokio::time::interval(Duration::from_millis(20));

    loop {
        tokio::select! {
            _ = interval.tick() => {
                loop {
                    match audio.try_recv() {
                        Ok(chunk) => {
                            let pcm = resample_to_pcm16(&chunk, source_sample_rate, TARGET_SAMPLE_RATE);
                            if pcm.is_empty() { continue; }
                            writer.send(Message::Text(json!({
                                "type": "input_audio_buffer.append",
                                "audio": BASE64.encode(pcm)
                            }).to_string())).await.map_err(|error| format!("Failed to stream audio: {error}"))?;
                        }
                        Err(TryRecvError::Empty) => break,
                        Err(TryRecvError::Disconnected) => {
                            producer_closed = true;
                            break;
                        }
                    }
                }

                if producer_closed && !commit_sent {
                    writer.send(Message::Text(json!({ "type": "input_audio_buffer.commit" }).to_string()))
                        .await
                        .map_err(|error| format!("Failed to finish realtime audio: {error}"))?;
                    commit_sent = true;
                    finish_deadline = Some(tokio::time::Instant::now() + Duration::from_secs(8));
                }

                if finish_deadline.is_some_and(|deadline| tokio::time::Instant::now() >= deadline) {
                    break;
                }
            }
            incoming = reader.next() => {
                let Some(message) = incoming else { break };
                let message = message.map_err(|error| format!("Realtime API read failed: {error}"))?;
                let Message::Text(text) = message else { continue };
                let event: Value = serde_json::from_str(&text)
                    .map_err(|error| format!("Invalid realtime API event: {error}"))?;

                match event.get("type").and_then(Value::as_str).unwrap_or_default() {
                    "conversation.item.input_audio_transcription.delta" => {
                        if let Some(delta) = event.get("delta").and_then(Value::as_str) {
                            current_delta.push_str(delta);
                        }
                    }
                    "conversation.item.input_audio_transcription.completed" => {
                        let transcript = event.get("transcript").and_then(Value::as_str).unwrap_or(&current_delta);
                        append_segment(&mut completed_transcript, transcript);
                        current_delta.clear();
                        if producer_closed { break; }
                    }
                    "error" => {
                        let message = event.pointer("/error/message").and_then(Value::as_str).unwrap_or("Unknown realtime API error");
                        return Err(format!("Realtime API error: {message}"));
                    }
                    _ => {}
                }
            }
        }
    }

    if !current_delta.trim().is_empty() {
        append_segment(&mut completed_transcript, &current_delta);
    }

    let transcript = completed_transcript.trim().to_string();
    if transcript.is_empty() {
        Err("Realtime transcription returned no text".to_string())
    } else {
        Ok(transcript)
    }
}

fn transcription_settings(model: &str, prompt: &str) -> Value {
    let selected_model = match model {
        "gpt-4o-transcribe" => "gpt-4o-transcribe",
        _ => "gpt-4o-mini-transcribe",
    };
    let mut transcription = json!({
        "model": selected_model,
        // Scribe currently records English dictation only. This prevents the model from
        // interpreting uncertain speech or trailing room noise as another language.
        "language": TRANSCRIPTION_LANGUAGE,
    });
    if !prompt.trim().is_empty() {
        transcription["prompt"] = Value::String(prompt.to_string());
    }
    transcription
}

fn append_segment(transcript: &mut String, segment: &str) {
    let segment = segment.trim();
    if segment.is_empty() {
        return;
    }
    if !transcript.is_empty() {
        transcript.push(' ');
    }
    transcript.push_str(segment);
}

fn resample_to_pcm16(samples: &[f32], source_rate: u32, target_rate: u32) -> Vec<u8> {
    if samples.is_empty() || source_rate == 0 {
        return Vec::new();
    }
    let output_len = samples.len().saturating_mul(target_rate as usize) / source_rate as usize;
    let mut output = Vec::with_capacity(output_len * 2);
    for index in 0..output_len {
        let source_index = index.saturating_mul(source_rate as usize) / target_rate as usize;
        let sample = samples[source_index.min(samples.len() - 1)].clamp(-1.0, 1.0);
        output.extend_from_slice(&((sample * i16::MAX as f32) as i16).to_le_bytes());
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resampling_produces_24khz_pcm16() {
        let input = vec![0.5; 48_000];
        let output = resample_to_pcm16(&input, 48_000, 24_000);
        assert_eq!(output.len(), 24_000 * 2);
    }

    #[test]
    fn transcription_settings_are_english_without_an_implicit_prompt() {
        let settings = transcription_settings("gpt-4o-mini-transcribe", "");

        assert_eq!(settings["model"], "gpt-4o-mini-transcribe");
        assert_eq!(settings["language"], "en");
        assert!(settings.get("prompt").is_none());
    }

    #[test]
    fn segments_are_joined_without_empty_gaps() {
        let mut transcript = String::new();
        append_segment(&mut transcript, " hello ");
        append_segment(&mut transcript, "");
        append_segment(&mut transcript, "world");
        assert_eq!(transcript, "hello world");
    }
}
