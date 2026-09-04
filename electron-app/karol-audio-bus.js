/**
 * Karol mono mixer — two buses (music + vocal) → EQ3 → mono sum → soft limit → stereo duplicate.
 * Never call createMediaElementSource on the HDMI <video>; use <audio> stems or a parallel tap.
 *
 * Gain map (Out / Vocals faders are 0–1 UI):
 *   output = (ui ^ 2) * MASTER_TRIM
 * Square taper gives usable low-end range; MASTER_TRIM keeps hot karaoke masters
 * from slamming the UMC even at Out=100%.
 */
(function (global) {
  'use strict';

  var EQ_MAX_DB = 12;
  // ~-11 dB ceiling at Out=100% — karaoke masters + mono L=R were near-unity before.
  var MASTER_TRIM = 0.28;
  var sources = new WeakMap(); // HTMLMediaElement -> MediaElementAudioSourceNode

  function clamp01(n, fb) {
    var v = Number(n);
    if (!isFinite(v)) return fb == null ? 0 : fb;
    return Math.max(0, Math.min(1, v));
  }

  function clampDb(n) {
    var v = Number(n);
    if (!isFinite(v)) return 0;
    return Math.max(-EQ_MAX_DB, Math.min(EQ_MAX_DB, v));
  }

  /** UI fader 0–1 → linear amplitude into the PA path. */
  function uiToOutputGain(ui01) {
    var t = clamp01(ui01, 0);
    return (t * t) * MASTER_TRIM;
  }

  function createEq3(ctx) {
    // Ableton EQ Three–ish: musical shelves + mid peak (audible on PA)
    var low = ctx.createBiquadFilter();
    low.type = 'lowshelf';
    low.frequency.value = 250;
    low.gain.value = 0;
    var mid = ctx.createBiquadFilter();
    mid.type = 'peaking';
    mid.frequency.value = 1000;
    mid.Q.value = 1.0;
    mid.gain.value = 0;
    var high = ctx.createBiquadFilter();
    high.type = 'highshelf';
    high.frequency.value = 6000;
    high.gain.value = 0;
    low.connect(mid);
    mid.connect(high);
    return {
      input: low,
      output: high,
      low: low,
      mid: mid,
      high: high,
      set: function (eq) {
        eq = eq || {};
        var ctx = low.context;
        var t = ctx.currentTime;
        // setTargetAtTime so Chromium reliably applies while the graph is running
        low.gain.setTargetAtTime(clampDb(eq.low), t, 0.01);
        mid.gain.setTargetAtTime(clampDb(eq.mid), t, 0.01);
        high.gain.setTargetAtTime(clampDb(eq.high), t, 0.01);
      },
      get: function () {
        return { low: low.gain.value, mid: mid.gain.value, high: high.gain.value };
      },
    };
  }

  function createBus(ctx) {
    var gain = ctx.createGain();
    gain.gain.value = 0.55;
    var eq = createEq3(ctx);
    var analyser = ctx.createAnalyser();
    // 1024 = smoother meters; still light on the audio thread
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.4;

    // Meter FIRST (post-EQ), then mono downmix for the PA path.
    // Putting channelCount=1 *before* the analyser zeroed meter reads in Chromium.
    var mono = ctx.createGain();
    mono.channelCount = 1;
    mono.channelCountMode = 'explicit';
    mono.channelInterpretation = 'speakers';
    mono.gain.value = 1;

    gain.connect(eq.input);
    eq.output.connect(analyser);
    analyser.connect(mono);

    var timeData = new Float32Array(analyser.fftSize);
    var peakHold = 0;
    var peakHoldUntil = 0;

    return {
      gain: gain,
      eq: eq,
      analyser: analyser,
      mono: mono,
      output: mono,
      setGain: function (v, rampSec) {
        var target = clamp01(v, 0);
        var param = gain.gain;
        var now = gain.context.currentTime;
        var ramp = rampSec != null ? Number(rampSec) : 0.035;
        if (!isFinite(ramp) || ramp < 0) ramp = 0.035;
        try {
          param.cancelScheduledValues(now);
          param.setValueAtTime(param.value, now);
          if (ramp <= 0.001) {
            param.value = target;
          } else {
            param.linearRampToValueAtTime(target, now + ramp);
          }
        } catch (_) {
          param.value = target;
        }
      },
      getGain: function () {
        return gain.gain.value;
      },
      readMeter: function (now) {
        analyser.getFloatTimeDomainData(timeData);
        var peak = 0;
        var sumSq = 0;
        for (var i = 0; i < timeData.length; i++) {
          var s = timeData[i];
          var a = s < 0 ? -s : s;
          if (a > peak) peak = a;
          sumSq += s * s;
        }
        var rms = Math.sqrt(sumSq / timeData.length);
        if (peak >= peakHold || now > peakHoldUntil) {
          peakHold = peak;
          peakHoldUntil = now + 800;
        } else {
          peakHold *= 0.96;
        }
        return { peak: peak, rms: rms, peakHold: peakHold, clip: peak >= 0.98 };
      },
    };
  }

  function KarolAudioBus(opts) {
    opts = opts || {};
    var Ctx = global.AudioContext || global.webkitAudioContext;
    // Do NOT force sampleRate — mismatch with the device clock causes resampling glitches.
    var ctxOpts = { latencyHint: opts.latencyHint || 'interactive' };
    this.ctx = new Ctx(ctxOpts);
    this.music = createBus(this.ctx);
    this.vocal = createBus(this.ctx);

    this._sum = this.ctx.createGain();
    this._sum.gain.value = 1;
    // Prefer .output (post-analyser mono); fall back to analyser for safety
    (this.music.output || this.music.analyser).connect(this._sum);
    (this.vocal.output || this.vocal.analyser).connect(this._sum);

    // Soft limiter (catch hot masters before PA)
    this._comp = this.ctx.createDynamicsCompressor();
    this._comp.threshold.value = -12;
    this._comp.knee.value = 8;
    this._comp.ratio.value = 8;
    this._comp.attack.value = 0.003;
    this._comp.release.value = 0.22;
    this._makeup = this.ctx.createGain();
    // No makeup boost — trim already sets show-night headroom
    this._makeup.gain.value = 1;

    // Soft clip safety (unity small-signal gain — do not boost)
    this._shaper = this.ctx.createWaveShaper();
    this._shaper.curve = (function () {
      var n = 2048;
      var curve = new Float32Array(n);
      for (var i = 0; i < n; i++) {
        var x = (i * 2) / (n - 1) - 1;
        curve[i] = Math.tanh(x);
      }
      return curve;
    })();

    this._merger = this.ctx.createChannelMerger(2);
    this._sum.connect(this._comp);
    this._comp.connect(this._makeup);
    this._makeup.connect(this._shaper);
    this._shaper.connect(this._merger, 0, 0);
    this._shaper.connect(this._merger, 0, 1);
    this._merger.connect(this.ctx.destination);

    this._musicEl = null;
    this._vocalEl = null;
    this._musicSrc = null;
    this._vocalSrc = null;
    this._musicFader = 0.55;
    this._vocalFader = 0;

    var self = this;
    this.ctx.onstatechange = function () {
      if (self.ctx.state === 'suspended') {
        self.ctx.resume().catch(function () {});
      }
    };
  }

  KarolAudioBus.prototype.resume = function () {
    if (this.ctx.state === 'suspended') return this.ctx.resume();
    return Promise.resolve();
  };

  KarolAudioBus.prototype._sourceFor = function (el) {
    if (!el) return null;
    var existing = sources.get(el);
    if (existing) return existing;
    var src = this.ctx.createMediaElementSource(el);
    sources.set(el, src);
    return src;
  };

  KarolAudioBus.prototype.attachMusic = function (el) {
    if (el === this._musicEl) return;
    if (this._musicSrc) {
      try { this._musicSrc.disconnect(); } catch (_) {}
      this._musicSrc = null;
    }
    this._musicEl = el || null;
    if (!el) return;
    try {
      el.volume = 1;
      el.muted = false;
    } catch (_) {}
    this._musicSrc = this._sourceFor(el);
    if (this._musicSrc) this._musicSrc.connect(this.music.gain);
    this.resume();
  };

  KarolAudioBus.prototype.attachVocal = function (el) {
    if (el === this._vocalEl) return;
    if (this._vocalSrc) {
      try { this._vocalSrc.disconnect(); } catch (_) {}
      this._vocalSrc = null;
    }
    this._vocalEl = el || null;
    if (!el) return;
    try {
      el.volume = 1;
      el.muted = false;
    } catch (_) {}
    this._vocalSrc = this._sourceFor(el);
    if (this._vocalSrc) this._vocalSrc.connect(this.vocal.gain);
    this.resume();
  };

  KarolAudioBus.prototype.detachMusic = function () {
    this.attachMusic(null);
  };

  KarolAudioBus.prototype.detachVocal = function () {
    this.attachVocal(null);
  };

  KarolAudioBus.prototype.setMusicGain = function (v, rampSec) {
    this._musicFader = clamp01(v, 0);
    this.music.setGain(uiToOutputGain(this._musicFader), rampSec);
  };

  KarolAudioBus.prototype.setVocalGain = function (v, rampSec) {
    this._vocalFader = clamp01(v, 0);
    this.vocal.setGain(uiToOutputGain(this._vocalFader), rampSec);
  };

  /** Last UI fader value (0–1), before taper/trim — for fades that must stay in UI space. */
  KarolAudioBus.prototype.getMusicFader = function () {
    return this._musicFader;
  };

  KarolAudioBus.prototype.getVocalFader = function () {
    return this._vocalFader;
  };

  KarolAudioBus.prototype.setMusicEq = function (eq) {
    this.music.eq.set(eq);
  };

  KarolAudioBus.prototype.setVocalEq = function (eq) {
    this.vocal.eq.set(eq);
  };

  KarolAudioBus.prototype.getMusicEq = function () {
    return this.music.eq.get();
  };

  KarolAudioBus.prototype.getVocalEq = function () {
    return this.vocal.eq.get();
  };

  KarolAudioBus.prototype.getMeters = function () {
    var now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    var m = this.music.readMeter(now);
    var v = this.vocal.readMeter(now);
    return {
      musicPeak: m.peak,
      musicRms: m.rms,
      musicPeakHold: m.peakHold,
      vocalPeak: v.peak,
      vocalRms: v.rms,
      vocalPeakHold: v.peakHold,
      clip: !!(m.clip || v.clip),
    };
  };

  global.KarolAudioBus = KarolAudioBus;
  global.KAROL_EQ_MAX_DB = EQ_MAX_DB;
  global.KAROL_MASTER_TRIM = MASTER_TRIM;
  global.karolUiToOutputGain = uiToOutputGain;
})(typeof window !== 'undefined' ? window : globalThis);
