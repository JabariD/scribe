"""Regenerates Scribe's UI sounds: python3 generate.py

Short, quiet sine tones with soft attacks so they confirm an action without
startling. Kept as source so the sounds can be tuned instead of re-sourced.
"""
import math
import struct
import wave
from pathlib import Path

RATE = 44_100


def tone(freq_start, freq_end, ms, gain, attack_ms=4.0, decay=5.0, harmonics=(1.0, 0.18, 0.05)):
    count = int(RATE * ms / 1000)
    attack = max(1, int(RATE * attack_ms / 1000))
    phase = 0.0
    out = []
    for i in range(count):
        t = i / count
        # Exponential glide sounds more natural than a linear pitch ramp.
        freq = freq_start * (freq_end / freq_start) ** t
        phase += 2 * math.pi * freq / RATE
        sample = sum(amp * math.sin(phase * (n + 1)) for n, amp in enumerate(harmonics))
        envelope = min(1.0, i / attack) * math.exp(-decay * t)
        # Fade the tail to zero so the sound never ends on a click.
        envelope *= min(1.0, (count - i) / attack)
        out.append(sample * envelope * gain)
    return out


def silence(ms):
    return [0.0] * int(RATE * ms / 1000)


def mix(*parts):
    length = max(len(part) for part in parts)
    return [sum(part[i] for part in parts if i < len(part)) for i in range(length)]


def write(name, samples):
    path = Path(__file__).with_name(f"{name}.wav")
    with wave.open(str(path), "wb") as file:
        file.setnchannels(1)
        file.setsampwidth(2)
        file.setframerate(RATE)
        file.writeframes(b"".join(struct.pack("<h", int(max(-1, min(1, s)) * 32767)) for s in samples))


# Rising: "listening".
write("start", tone(620, 930, 110, 0.20, decay=4.0))
# Falling mirror of start: "got it".
write("stop", tone(930, 620, 100, 0.17, decay=4.5))
# Two soft bell notes a fifth apart: "done, copied".
write("success", mix(
    tone(1318, 1318, 170, 0.09, decay=6.0),
    silence(55) + tone(1975, 1975, 220, 0.07, decay=6.5),
))
# Low, short drop: "never mind".
write("cancel", tone(520, 360, 110, 0.14, decay=5.0))
# Single tick: pause/resume.
write("pause", tone(760, 760, 45, 0.12, decay=7.0))
# Two low pulses: something needs attention.
write("error", tone(300, 280, 110, 0.20, decay=4.0) + silence(50) + tone(250, 230, 150, 0.20, decay=4.0))
