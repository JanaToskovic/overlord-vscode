#!/usr/bin/env python
"""GENTLE, non-startling notification sounds -> media/candidates2/*.wav.
Design goals: low volume (peak ~0.26), slow fade-in (no sudden onset),
warm/low pitch, smooth fade-out (no click). Stdlib only.
"""
import wave, math, struct, os

SR = 44100
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "media", "candidates2")

# warm, low-ish pitches
A4, C5, E5, G5, A5 = 440.00, 523.25, 659.25, 783.99, 880.00


def normalize(s, peak=0.26):
    m = max((abs(x) for x in s), default=1.0) or 1.0
    return [x * (peak / m) for x in s]


def write(name, s):
    os.makedirs(OUT, exist_ok=True)
    s = normalize(s)
    with wave.open(os.path.join(OUT, name + ".wav"), "w") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
        b = bytearray()
        for x in s:
            b += struct.pack("<h", int(max(-1.0, min(1.0, x)) * 32767))
        w.writeframes(bytes(b))
    print(f"  {name}: {len(s)/SR:.2f}s")


def env(i, n, atk_s, rel_s):
    """Cosine fade-in over atk_s and cosine fade-out over rel_s -> no clicks,
    no startle."""
    a = max(1, int(atk_s * SR)); r = max(1, int(rel_s * SR))
    fin = (1 - math.cos(math.pi * min(i, a) / a)) / 2
    left = n - i
    fout = (1 - math.cos(math.pi * min(left, r) / r)) / 2
    return fin * fout


def voice(freqs, dur, atk, rel, decay, harm=()):
    """Sum of soft sines with slow fade-in, gentle exp decay, smooth fade-out."""
    n = int(SR * dur); out = []
    for i in range(n):
        t = i / SR; s = 0.0
        for f in freqs:
            s += math.sin(2*math.pi*f*t)
            for hn, ha in harm:
                s += ha * math.sin(2*math.pi*f*hn*t)
        out.append(env(i, n, atk, rel) * math.exp(-decay*t) * s)
    return out


def main():
    # A. HUSH — a single warm low tone (A4) that fades in and out like a breath.
    #    No transient at all. The most subtle.
    write("A_hush", voice([A4], 0.9, atk=0.14, rel=0.35, decay=1.6,
                           harm=[(2, 0.10)]))

    # B. VELVET — soft perfect fifth pad (C5+G5), slow swell. Warm, calm chord.
    write("B_velvet", voice([C5, G5], 1.0, atk=0.18, rel=0.4, decay=1.3,
                            harm=[(2, 0.06)]))

    # C. DROP — gentle rounded "water drop": quick-but-soft attack, mellow tone
    #    with a slight downward pitch feel via fast-decaying upper harmonic.
    n = int(SR * 0.7); drop = []
    for i in range(n):
        t = i / SR
        s = math.sin(2*math.pi*A4*t) + 0.25*math.sin(2*math.pi*A5*t)*math.exp(-9*t)
        drop.append(env(i, n, 0.02, 0.3) * math.exp(-3.4*t) * s)
    write("C_drop", drop)


if __name__ == "__main__":
    print("writing gentle candidates:")
    main()
