//! Audio conversion shared by saved recordings, OpenAI uploads, and local transcription.

use std::fs::File;
use std::io::BufWriter;
use std::path::Path;

/// Speech models run at 16 kHz, so recordings are stored at that rate: a third of the
/// bytes of a 48 kHz capture, which shortens OpenAI uploads with no accuracy cost.
pub const TARGET_SAMPLE_RATE: u32 = 16_000;

/// Resamples mono audio by averaging the source samples that fall in each output slot.
/// The averaging acts as a low-pass filter, avoiding the aliasing of plain decimation.
pub fn resample(samples: &[f32], source_rate: u32, target_rate: u32) -> Vec<f32> {
    if samples.is_empty() || source_rate == 0 || target_rate == 0 {
        return Vec::new();
    }
    if source_rate == target_rate {
        return samples.to_vec();
    }

    let ratio = f64::from(source_rate) / f64::from(target_rate);
    let output_len = (samples.len() as f64 / ratio) as usize;
    let mut output = Vec::with_capacity(output_len);
    for index in 0..output_len {
        let start = (index as f64 * ratio) as usize;
        let end = (((index + 1) as f64 * ratio) as usize).clamp(start + 1, samples.len());
        let window = &samples[start.min(samples.len() - 1)..end];
        output.push(window.iter().sum::<f32>() / window.len() as f32);
    }
    output
}

pub fn write_wav_16k(path: &Path, samples: &[f32]) -> Result<(), String> {
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: TARGET_SAMPLE_RATE,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let file =
        File::create(path).map_err(|error| format!("Failed to create recording: {error}"))?;
    let mut writer = hound::WavWriter::new(BufWriter::new(file), spec)
        .map_err(|error| format!("Failed to write recording: {error}"))?;
    for sample in samples {
        writer
            .write_sample((sample.clamp(-1.0, 1.0) * i16::MAX as f32) as i16)
            .map_err(|error| format!("Failed to write recording: {error}"))?;
    }
    writer
        .finalize()
        .map_err(|error| format!("Failed to write recording: {error}"))
}

/// Reads any mono or multi-channel PCM WAV as mono 16 kHz samples.
pub fn read_wav_mono_16k(path: &Path) -> Result<Vec<f32>, String> {
    let mut reader = hound::WavReader::open(path)
        .map_err(|error| format!("Failed to read recording: {error}"))?;
    let spec = reader.spec();
    let interleaved: Vec<f32> = match spec.sample_format {
        hound::SampleFormat::Float => reader
            .samples::<f32>()
            .collect::<Result<_, _>>()
            .map_err(|error| format!("Failed to read recording: {error}"))?,
        hound::SampleFormat::Int => {
            let scale = (1_i64 << (spec.bits_per_sample - 1)) as f32;
            reader
                .samples::<i32>()
                .map(|sample| sample.map(|value| value as f32 / scale))
                .collect::<Result<_, _>>()
                .map_err(|error| format!("Failed to read recording: {error}"))?
        }
    };
    let channels = usize::from(spec.channels.max(1));
    let mono: Vec<f32> = interleaved
        .chunks(channels)
        .map(|frame| frame.iter().sum::<f32>() / frame.len() as f32)
        .collect();
    Ok(resample(&mono, spec.sample_rate, TARGET_SAMPLE_RATE))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resampling_48k_to_16k_keeps_duration_and_level() {
        let output = resample(&vec![0.5; 48_000], 48_000, 16_000);
        assert_eq!(output.len(), 16_000);
        assert!(output.iter().all(|sample| (sample - 0.5).abs() < 1e-6));
    }

    #[test]
    fn resampling_non_integer_ratio_keeps_duration() {
        assert_eq!(resample(&vec![0.1; 44_100], 44_100, 16_000).len(), 16_000);
    }

    #[test]
    fn resampling_filters_frequencies_above_the_target_nyquist() {
        // A 24 kHz tone sampled at 48 kHz alternates +1/-1; plain decimation would keep it.
        let tone: Vec<f32> = (0..4_800)
            .map(|i| if i % 2 == 0 { 1.0 } else { -1.0 })
            .collect();
        let output = resample(&tone, 48_000, 16_000);
        let peak = output
            .iter()
            .fold(0.0_f32, |max, sample| max.max(sample.abs()));
        assert!(peak <= 1.0 / 3.0 + 1e-6, "peak {peak}");
    }

    #[test]
    fn wav_round_trip_is_mono_16k() {
        let path =
            std::env::temp_dir().join(format!("scribe-audio-test-{}.wav", std::process::id()));
        write_wav_16k(&path, &vec![0.25; 16_000]).unwrap();
        let samples = read_wav_mono_16k(&path).unwrap();
        assert_eq!(samples.len(), 16_000);
        assert!((samples[100] - 0.25).abs() < 1e-3);
        std::fs::remove_file(path).unwrap();
    }
}
