"""Music bed and sound effects for the Firstprint videos, synthesised from scratch (no samples).

python3 gen_audio.py out-x/v1.sfx.json out-x/v1.wav
The JSON holds the video's total duration and its cues [time, kind, variant].
"""
import json
import sys
import wave

import numpy as np

SR = 48000
STRETCH = 1.22  # the X cut plays the video 1.22x slower; coin flights scale with it
HOOK = 2.6
rng = np.random.default_rng(7)


def t_arr(dur):
    return np.arange(int(dur * SR)) / SR


def env(n, a=0.005, r=0.2, sustain=0.0):
    """Attack then exponential decay."""
    t = np.arange(n) / SR
    e = np.minimum(1, t / max(a, 1e-4)) * np.exp(-t / max(r, 1e-4))
    return e


def lowpass(x, cutoff):
    a = np.exp(-2 * np.pi * cutoff / SR)
    y = np.empty_like(x)
    acc = 0.0
    for i, v in enumerate(x):
        acc = (1 - a) * v + a * acc
        y[i] = acc
    return y


def fast_lowpass(x, cutoff):
    """One-pole low-pass via FFT (fast enough for long buffers)."""
    n = len(x)
    f = np.fft.rfftfreq(n, 1 / SR)
    h = 1 / np.sqrt(1 + (f / cutoff) ** 4)
    return np.fft.irfft(np.fft.rfft(x) * h, n)


def bandpass(x, lo, hi):
    n = len(x)
    f = np.fft.rfftfreq(n, 1 / SR)
    h = ((f >= lo) & (f <= hi)).astype(float)
    # soft edges
    h = np.convolve(h, np.hanning(64) / np.hanning(64).sum(), mode='same')
    return np.fft.irfft(np.fft.rfft(x) * h, n)


def note(m):
    return 440.0 * 2 ** ((m - 69) / 12)


# --- Sound effects ------------------------------------------------------------------------------

def sfx_whoosh(dur=0.55, lo=300, hi=4000, gain=0.5):
    n = int(dur * SR)
    x = bandpass(rng.standard_normal(n), lo, hi)
    t = np.arange(n) / n
    e = np.sin(np.pi * t) ** 1.6
    x = x * e
    return x / (np.abs(x).max() + 1e-9) * gain


def sfx_swell(dur=0.9):
    n = int(dur * SR)
    t = np.arange(n) / SR
    x = bandpass(rng.standard_normal(n), 800, 6000) * (t / dur) ** 2.2
    tone = np.sin(2 * np.pi * note(84) * t) * 0.15 * (t / dur) ** 3
    y = x / (np.abs(x).max() + 1e-9) * 0.06 + tone
    return y * np.minimum(1, (dur - t) / 0.03)


def sfx_blip(i=0):
    scale = [72, 74, 76, 79, 81, 84, 86]
    f = note(scale[int(i) % len(scale)] + 12)
    n = int(0.16 * SR)
    t = np.arange(n) / SR
    y = (np.sin(2 * np.pi * f * t) + 0.3 * np.sin(2 * np.pi * 2 * f * t)) * env(n, 0.002, 0.045)
    return y * 0.32


def sfx_tap():
    n = int(0.06 * SR)
    t = np.arange(n) / SR
    click = bandpass(rng.standard_normal(n), 2000, 9000) * env(n, 0.0005, 0.006)
    body = np.sin(2 * np.pi * 900 * t * (1 - t * 4)) * env(n, 0.001, 0.02)
    return (click * 0.5 + body * 0.5) * 0.7


def sfx_pop():
    n = int(0.12 * SR)
    t = np.arange(n) / SR
    f = 950 - 450 * (t / t[-1])
    ph = 2 * np.pi * np.cumsum(f) / SR
    return np.sin(ph) * env(n, 0.002, 0.035) * 0.5


def sfx_tick():
    n = int(0.07 * SR)
    t = np.arange(n) / SR
    y = np.sin(2 * np.pi * 1850 * t) * env(n, 0.0007, 0.012) + 0.4 * np.sin(2 * np.pi * 3700 * t) * env(n, 0.0005, 0.006)
    return y * 0.45


def sfx_lock():
    a = sfx_tick() * 0.8
    b = sfx_tap()
    n = int(0.35 * SR)
    t = np.arange(n) / SR
    thunk = np.sin(2 * np.pi * (140 - 60 * t / t[-1]) * t) * env(n, 0.002, 0.08) * 0.7
    out = np.zeros(n)
    out[: len(a)] += a
    k = int(0.06 * SR)
    out[k : k + len(b)] += b
    out += thunk
    return out


def sfx_riser(dur=3.0):
    n = int(dur * SR)
    t = np.arange(n) / SR
    f = 180 * (7 ** (t / dur))
    ph = 2 * np.pi * np.cumsum(f) / SR
    tone = np.sin(ph) * 0.18 + np.sin(ph * 1.5) * 0.06
    noise = bandpass(rng.standard_normal(n), 1500, 9000) * 0.12
    e = (t / dur) ** 1.8
    # ticks speeding up
    ticks = np.zeros(n)
    k = 0.0
    while k < dur:
        i = int(k * SR)
        tk = sfx_tick() * 0.6
        ticks[i : i + len(tk)] += tk[: n - i]
        k += 0.32 * (1 - 0.82 * k / dur)
    return (tone + noise) * e + ticks


def sfx_impact():
    n = int(1.1 * SR)
    t = np.arange(n) / SR
    boom = np.sin(2 * np.pi * (70 - 30 * np.minimum(1, t / 0.4)) * t) * env(n, 0.002, 0.35)
    crack = bandpass(rng.standard_normal(n), 300, 5000) * env(n, 0.001, 0.05)
    return boom * 0.9 + crack * 0.4


def bell(f, dur=0.6, gain=0.3):
    n = int(dur * SR)
    t = np.arange(n) / SR
    y = np.zeros(n)
    for mult, amp, dec in [(1, 1, 0.35), (2.76, 0.4, 0.18), (5.4, 0.2, 0.08), (8.9, 0.1, 0.04)]:
        y += amp * np.sin(2 * np.pi * f * mult * t) * np.exp(-t / dec)
    return y * env(n, 0.001, 10) * gain


def sfx_success():
    out = np.zeros(int(0.9 * SR))
    for i, m in enumerate([84, 88, 91, 96]):
        b = bell(note(m), 0.7, 0.22)
        k = int(i * 0.07 * SR)
        out[k : k + len(b)] += b[: len(out) - k]
    return out


def sfx_coin():
    f = note(int(rng.choice([96, 98, 100, 103, 105])))
    return bell(f, 0.32, 0.14)


def sfx_cash():
    out = np.zeros(int(1.0 * SR))
    for i in range(6):
        b = bell(note(100 + (i % 3) * 3), 0.4, 0.09)
        k = int(i * 0.045 * SR)
        out[k : k + len(b)] += b[: len(out) - k]
    return out


def sfx_chime():
    out = np.zeros(int(2.2 * SR))
    for i, m in enumerate([72, 76, 79, 83, 86]):
        b = bell(note(m), 2.0, 0.12)
        k = int(i * 0.05 * SR)
        out[k : k + len(b)] += b[: len(out) - k]
    return out


def sfx_note(i=0):
    """A soft, warm pluck for captions landing: no noise, just a rounded tone."""
    f = note([69, 76, 81][int(i) % 3])
    n = int(0.9 * SR)
    t = np.arange(n) / SR
    y = (np.sin(2 * np.pi * f * t) + 0.25 * np.sin(2 * np.pi * 2 * f * t) + 0.08 * np.sin(2 * np.pi * 3 * f * t)) * np.exp(-t / 0.22)
    return lowpass(y * env(n, 0.006, 10), 3000) * 0.3


def sfx_land():
    """A card settling into place: a soft low thump with a tiny tick."""
    n = int(0.35 * SR)
    t = np.arange(n) / SR
    thump = np.sin(2 * np.pi * (120 - 40 * np.minimum(1, t / 0.15)) * t) * np.exp(-t / 0.07)
    tk = np.sin(2 * np.pi * 2400 * t) * np.exp(-t / 0.004) * 0.12
    return (thump * 0.45 + tk) * env(n, 0.003, 10)


def sfx_shimmer():
    out = np.zeros(int(0.8 * SR))
    for i, m in enumerate([91, 95, 98, 103]):
        b = bell(note(m), 0.5, 0.06)
        k = int(i * 0.04 * SR)
        out[k : k + len(b)] += b[: len(out) - k]
    return out


# --- Music bed ------------------------------------------------------------------------------------

def music(total):
    bpm = 104
    beat = 60 / bpm
    n = int(total * SR)
    L = np.zeros(n)
    R = np.zeros(n)
    # Am9, Fmaj7, Cmaj7, G6 — one chord a bar.
    chords = [[57, 60, 64, 67, 71], [53, 57, 60, 64, 69], [48, 55, 59, 64, 67], [55, 59, 62, 64, 67]]
    roots = [45, 41, 48, 43]
    bar = 4 * beat
    drums_in = HOOK
    drums_out = total - 2.8
    # Pad: detuned saws, low-passed, per bar with soft crossfade.
    t_all = np.arange(n) / SR
    pad = np.zeros(n)
    nb = int(np.ceil(total / bar)) + 1
    for b in range(nb):
        s = int(b * bar * SR)
        if s >= n:
            break
        ln = min(n - s, int((bar + 0.4) * SR))
        tt = np.arange(ln) / SR
        seg = np.zeros(ln)
        for m in chords[b % 4]:
            for det in (-0.07, 0.07):
                f = note(m + det)
                seg += 2 * ((tt * f) % 1) - 1
        seg *= np.minimum(1, tt / 0.35) * np.minimum(1, (bar + 0.4 - tt) / 0.4)
        pad[s : s + ln] += seg
    pad = fast_lowpass(pad, 900) * 0.035
    # Sub bass on the root, following the beat.
    bass = np.zeros(n)
    for b in range(nb):
        for q in range(4):
            s = int((b * bar + q * beat) * SR)
            if s >= n or s / SR < drums_in or s / SR > drums_out:
                continue
            ln = min(n - s, int(beat * 0.9 * SR))
            tt = np.arange(ln) / SR
            bass[s : s + ln] += np.sin(2 * np.pi * note(roots[b % 4] - 12) * tt) * np.minimum(1, tt / 0.01) * np.exp(-tt / 0.5)
    bass *= 0.22
    # Pluck arpeggio in 8ths.
    pluck_l = np.zeros(n)
    pluck_r = np.zeros(n)
    pattern = [0, 2, 4, 2, 1, 3, 4, 3]
    for b in range(nb):
        ch = chords[b % 4]
        for e8 in range(8):
            s = int((b * bar + e8 * beat / 2) * SR)
            if s >= n:
                break
            ln = min(n - s, int(0.5 * SR))
            tt = np.arange(ln) / SR
            f = note(ch[pattern[e8]] + 12)
            v = (np.sin(2 * np.pi * f * tt) + 0.25 * np.sin(2 * np.pi * 2 * f * tt)) * np.exp(-tt / 0.16) * np.minimum(1, tt / 0.003)
            (pluck_l if e8 % 2 == 0 else pluck_r)[s : s + ln] += v
    pluck_l *= 0.07
    pluck_r *= 0.07
    # Drums: soft kick on every beat, hats on the off-beats, a clap on 2 and 4.
    kick = np.zeros(n)
    hat = np.zeros(n)
    clap = np.zeros(n)
    duck = np.ones(n)
    kn = int(0.32 * SR)
    kt = np.arange(kn) / SR
    kick_s = np.sin(2 * np.pi * np.cumsum(48 + 90 * np.exp(-kt / 0.03)) / SR) * np.exp(-kt / 0.12)
    hn = int(0.05 * SR)
    hat_s = bandpass(rng.standard_normal(hn), 7000, 14000) * np.exp(-np.arange(hn) / SR / 0.012)
    cn = int(0.18 * SR)
    clap_s = bandpass(rng.standard_normal(cn), 900, 5000) * np.exp(-np.arange(cn) / SR / 0.05)
    q = 0
    while True:
        ts = q * beat
        if ts >= total:
            break
        s = int(ts * SR)
        if drums_in <= ts <= drums_out:
            ln = min(kn, n - s)
            kick[s : s + ln] += kick_s[:ln]
            d = 1 - 0.55 * np.exp(-np.arange(min(int(0.25 * SR), n - s)) / SR / 0.08)
            duck[s : s + len(d)] *= d
            hs = int((ts + beat / 2) * SR)
            if hs < n:
                ln = min(hn, n - hs)
                hat[hs : hs + ln] += hat_s[:ln]
            if q % 2 == 1:
                ln = min(cn, n - s)
                clap[s : s + ln] += clap_s[:ln]
        q += 1
    kick *= 0.42
    hat *= 0.05
    clap *= 0.07
    # Build: low-pass the music during the hook, open it up when the video starts.
    mel = (pad + bass) * duck
    L += mel + pluck_l * duck + kick + hat * 0.8 + clap
    R += mel + pluck_r * duck + kick + hat * 1.2 + clap
    fade = np.minimum(1, t_all / 0.6) * np.minimum(1, (total - t_all) / 1.6)
    return L * fade, R * fade


# --- Mix --------------------------------------------------------------------------------------------

def place(buf_l, buf_r, x, at, pan=0.0, gain=1.0):
    s = int(at * SR)
    if s >= len(buf_l):
        return
    x = x[: len(buf_l) - s] * gain
    buf_l[s : s + len(x)] += x * (1 - max(0, pan))
    buf_r[s : s + len(x)] += x * (1 + min(0, pan))


def main(src, dst):
    data = json.load(open(src))
    total = data['duration']
    L, R = music(total)
    L *= 0.55
    R *= 0.55
    fx_l = np.zeros_like(L)
    fx_r = np.zeros_like(R)
    for cue in data['sfx']:
        t, kind = cue[0], cue[1]
        arg = cue[2] if len(cue) > 2 else None
        if kind in ('whoosh', 'swish'):
            continue  # dropped: noise sweeps read as irritating; camera moves ride on the music
        elif kind == 'note':
            place(fx_l, fx_r, sfx_note(arg or 0), t)
        elif kind == 'land':
            place(fx_l, fx_r, sfx_land(), t)
        elif kind == 'swell':
            place(fx_l, fx_r, sfx_swell(), t - 0.6)
        elif kind == 'blip':
            place(fx_l, fx_r, sfx_blip(arg or 0), t, pan=((arg or 0) % 3 - 1) * 0.3)
        elif kind == 'tap':
            place(fx_l, fx_r, sfx_tap(), t - 0.01)
        elif kind == 'pop':
            place(fx_l, fx_r, sfx_pop(), t)
        elif kind == 'tick':
            place(fx_l, fx_r, sfx_tick(), t)
        elif kind == 'lock':
            place(fx_l, fx_r, sfx_lock(), t)
        elif kind == 'riser':
            place(fx_l, fx_r, sfx_riser((arg or 3.0) * STRETCH), t, gain=0.8)
        elif kind == 'impact':
            place(fx_l, fx_r, sfx_impact(), t)
        elif kind == 'success':
            place(fx_l, fx_r, sfx_success(), t)
        elif kind == 'coins':
            count = int(arg or 12)
            for i in range(count):
                land = t + (i * 0.045 + (0.95 if count > 6 else 0.8)) * STRETCH
                place(fx_l, fx_r, sfx_coin(), land, pan=float(rng.uniform(-0.4, 0.4)))
        elif kind == 'cash':
            place(fx_l, fx_r, sfx_cash(), t, gain=0.9)
        elif kind == 'chime':
            place(fx_l, fx_r, sfx_chime(), t)
        elif kind == 'shimmer':
            place(fx_l, fx_r, sfx_shimmer(), t)
    L = L + fx_l
    R = R + fx_r
    # Gentle limiter and level.
    peak = max(np.abs(L).max(), np.abs(R).max(), 1e-9)
    L = np.tanh(L / peak * 1.4) / np.tanh(1.4) * 0.89
    R = np.tanh(R / peak * 1.4) / np.tanh(1.4) * 0.89
    pcm = (np.stack([L, R], axis=1) * 32767).astype(np.int16)
    with wave.open(dst, 'wb') as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
