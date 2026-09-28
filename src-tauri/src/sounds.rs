//! UI feedback sounds, played with a preloaded `NSSound` instead of spawning `afplay`, so a
//! sound starts within a frame of the action it confirms. Sources: `sounds/generate.py`.

// objc 0.2's macros reference a `cargo-clippy` cfg that current rustc flags as unknown.
#![allow(unexpected_cfgs)]

use objc::runtime::{Object, NO};
use objc::{class, msg_send, sel, sel_impl};
use std::cell::RefCell;
use std::collections::HashMap;

type Id = *mut Object;

// Low enough to confirm an action without competing with whatever the user is listening to.
const VOLUME: f32 = 0.55;

const SOUNDS: &[(&str, &[u8])] = &[
    ("start", include_bytes!("../sounds/start.wav")),
    ("stop", include_bytes!("../sounds/stop.wav")),
    ("success", include_bytes!("../sounds/success.wav")),
    ("cancel", include_bytes!("../sounds/cancel.wav")),
    ("pause", include_bytes!("../sounds/pause.wav")),
    ("error", include_bytes!("../sounds/error.wav")),
];

thread_local! {
    // NSSound objects are retained for the app's lifetime; there are six of them.
    static LOADED: RefCell<HashMap<&'static str, Id>> = RefCell::new(HashMap::new());
}

/// Plays a named sound, restarting it if it is already playing.
/// Must run on the main thread (see `play_sound_internal` in main.rs).
pub fn play_on_main_thread(name: &str) {
    let Some(&(key, bytes)) = SOUNDS.iter().find(|(key, _)| *key == name) else {
        return;
    };
    LOADED.with(|loaded| {
        let sound = *loaded
            .borrow_mut()
            .entry(key)
            .or_insert_with(|| load(bytes));
        if sound.is_null() {
            return;
        }
        unsafe {
            let _: () = msg_send![sound, stop];
            let _: () = msg_send![sound, play];
        }
    });
}

fn load(bytes: &'static [u8]) -> Id {
    unsafe {
        let data: Id = msg_send![class!(NSData), dataWithBytes: bytes.as_ptr() length: bytes.len()];
        let sound: Id = msg_send![class!(NSSound), alloc];
        let sound: Id = msg_send![sound, initWithData: data];
        if !sound.is_null() {
            let _: () = msg_send![sound, setVolume: VOLUME];
            let _: () = msg_send![sound, setLoops: NO];
        }
        sound
    }
}
