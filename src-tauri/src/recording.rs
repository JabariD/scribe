use parking_lot::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};

/// Core recording state machine - manages recording, pause, and audio data
pub struct RecordingState {
    pub is_recording: AtomicBool,
    pub is_paused: AtomicBool,
    pub audio_level: Mutex<f32>,
    pub samples: Mutex<Vec<f32>>,
    pub sample_rate: Mutex<u32>,
}

impl Default for RecordingState {
    fn default() -> Self {
        Self {
            is_recording: AtomicBool::new(false),
            is_paused: AtomicBool::new(false),
            audio_level: Mutex::new(0.0),
            samples: Mutex::new(Vec::new()),
            sample_rate: Mutex::new(44100),
        }
    }
}

impl RecordingState {
    /// Start recording - clears previous samples and resets pause state
    pub fn start(&self) {
        self.samples.lock().clear();
        self.is_recording.store(true, Ordering::SeqCst);
        self.is_paused.store(false, Ordering::SeqCst);
    }

    /// Stop recording - returns samples if any were captured
    pub fn stop(&self) -> Vec<f32> {
        self.is_recording.store(false, Ordering::SeqCst);
        self.is_paused.store(false, Ordering::SeqCst);
        *self.audio_level.lock() = 0.0;
        self.samples.lock().clone()
    }

    /// Cancel recording - discards all samples
    pub fn cancel(&self) {
        self.is_recording.store(false, Ordering::SeqCst);
        self.is_paused.store(false, Ordering::SeqCst);
        *self.audio_level.lock() = 0.0;
        self.samples.lock().clear();
    }

    /// Toggle pause state - returns new paused state
    pub fn toggle_pause(&self) -> bool {
        let was_paused = self.is_paused.load(Ordering::SeqCst);
        let now_paused = !was_paused;
        self.is_paused.store(now_paused, Ordering::SeqCst);
        if now_paused {
            *self.audio_level.lock() = 0.0;
        }
        now_paused
    }

    /// Check if currently recording (not stopped)
    pub fn is_active(&self) -> bool {
        self.is_recording.load(Ordering::SeqCst)
    }

    /// Check if paused
    pub fn is_paused(&self) -> bool {
        self.is_paused.load(Ordering::SeqCst)
    }

    /// Should capture audio? (recording and not paused)
    pub fn should_capture(&self) -> bool {
        self.is_recording.load(Ordering::SeqCst) && !self.is_paused.load(Ordering::SeqCst)
    }

    /// Add samples and update audio level
    pub fn push_samples(&self, data: &[f32]) {
        if !self.should_capture() {
            return;
        }
        
        // Calculate RMS audio level
        let sum: f32 = data.iter().map(|s| s * s).sum();
        let rms = (sum / data.len() as f32).sqrt();
        *self.audio_level.lock() = rms.min(1.0);
        
        self.samples.lock().extend_from_slice(data);
    }

    /// Get current audio level
    pub fn get_audio_level(&self) -> f32 {
        *self.audio_level.lock()
    }

    /// Check if recorded audio has meaningful content (not silent)
    pub fn has_audio_content(&self) -> bool {
        let samples = self.samples.lock();
        if samples.is_empty() {
            return false;
        }
        let sum: f32 = samples.iter().map(|s| s * s).sum();
        let rms = (sum / samples.len() as f32).sqrt();
        rms >= 0.001
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_initial_state() {
        let state = RecordingState::default();
        assert!(!state.is_active());
        assert!(!state.is_paused());
        assert!(state.samples.lock().is_empty());
    }

    #[test]
    fn test_start_recording() {
        let state = RecordingState::default();
        state.start();
        
        assert!(state.is_active());
        assert!(!state.is_paused());
        assert!(state.should_capture());
    }

    #[test]
    fn test_start_clears_previous_samples() {
        let state = RecordingState::default();
        state.samples.lock().extend_from_slice(&[0.1, 0.2, 0.3]);
        
        state.start();
        
        assert!(state.samples.lock().is_empty());
    }

    #[test]
    fn test_stop_recording() {
        let state = RecordingState::default();
        state.start();
        state.push_samples(&[0.5, 0.5, 0.5]);
        
        let samples = state.stop();
        
        assert!(!state.is_active());
        assert_eq!(samples.len(), 3);
        assert_eq!(state.get_audio_level(), 0.0);
    }

    #[test]
    fn test_cancel_discards_samples() {
        let state = RecordingState::default();
        state.start();
        state.push_samples(&[0.5, 0.5, 0.5]);
        
        state.cancel();
        
        assert!(!state.is_active());
        assert!(state.samples.lock().is_empty());
    }

    #[test]
    fn test_pause_stops_capture() {
        let state = RecordingState::default();
        state.start();
        
        let is_paused = state.toggle_pause();
        
        assert!(is_paused);
        assert!(state.is_active()); // still "recording" session
        assert!(state.is_paused());
        assert!(!state.should_capture()); // but not capturing
    }

    #[test]
    fn test_resume_from_pause() {
        let state = RecordingState::default();
        state.start();
        state.toggle_pause(); // pause
        
        let is_paused = state.toggle_pause(); // resume
        
        assert!(!is_paused);
        assert!(state.should_capture());
    }

    #[test]
    fn test_samples_not_captured_when_paused() {
        let state = RecordingState::default();
        state.start();
        state.push_samples(&[0.1, 0.2]);
        
        state.toggle_pause();
        state.push_samples(&[0.3, 0.4]); // should be ignored
        
        state.toggle_pause();
        state.push_samples(&[0.5, 0.6]);
        
        let samples = state.samples.lock();
        assert_eq!(samples.len(), 4); // only pre-pause and post-resume
    }

    #[test]
    fn test_has_audio_content_detects_silence() {
        let state = RecordingState::default();
        state.start();
        
        // Silent audio
        state.samples.lock().extend_from_slice(&[0.0001, -0.0001, 0.0]);
        assert!(!state.has_audio_content());
        
        // Reset and add real audio
        state.samples.lock().clear();
        state.samples.lock().extend_from_slice(&[0.5, -0.3, 0.4]);
        assert!(state.has_audio_content());
    }

    #[test]
    fn test_stop_also_clears_pause() {
        let state = RecordingState::default();
        state.start();
        state.toggle_pause();
        
        state.stop();
        
        assert!(!state.is_paused());
    }
}
