//! Local TTS for the review journey — persistent worker subprocesses speaking a
//! JSON-lines protocol, modeled on the video-explainer skill's engine:
//!
//! - **kokoro** (default): Kokoro-82M on the system python — proven, fast (~9×
//!   realtime after a ~2s model load), voice `af_heart`.
//! - **chatterbox** (optional): Resemble Chatterbox from the skill's isolated venv
//!   (`~/.cache/video-explainer/chatterbox-env` — chatterbox pins torch 2.6/numpy 1.x,
//!   so it must NOT run in the system env). The fun one: an `exaggeration` dial from
//!   deadpan (~0.25) through neutral (0.5) to theatrical (1.0) — the journey maps
//!   finding severity onto it. Output carries Resemble's inaudible PerTh watermark.
//!
//! `Command::Speak { id, text, backend?, intensity? }` → `Event::Speech { id, wav_b64 }`.
//! Failures degrade: chatterbox-unavailable reroutes to kokoro (engine-side); kokoro-
//! unavailable emits an empty Speech so the frontend uses the system voice.

use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command as PCommand, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use crate::protocol::Event;
use crate::session::EventSink;

/// Shared normalization (the skill's rule: pre-expand numbers/symbols for TTS).
const NORM_PY: &str = r#"
import re
try:
    from num2words import num2words
    def _num(m):
        try: return num2words(int(m.group(0)))
        except Exception: return m.group(0)
except Exception:
    def _num(m): return m.group(0)
def norm(t):
    t = t.replace("%", " percent").replace("&", " and ").replace("->", " to ")
    t = t.replace("/", " slash ").replace("_", " ").replace("`", "")
    return re.sub(r"\b\d{1,6}\b", _num, t)
"#;

/// Kokoro worker: loads once, synthesizes each request to 16-bit 24 kHz WAV base64.
const KOKORO_PY: &str = r#"
import sys, json, io, base64
import numpy as np
import soundfile as sf
from kokoro import KPipeline
pipe = KPipeline(lang_code="a", repo_id="hexgrad/Kokoro-82M")
print(json.dumps({"id": "__ready__"}), flush=True)
for line in sys.stdin:
    rid = "?"
    try:
        req = json.loads(line)
        rid = req["id"]
        chunks = [np.asarray(a, dtype=np.float32)
                  for _, _, a in pipe(norm(req["text"]), voice=req.get("voice") or "af_heart",
                                      speed=0.95, split_pattern=r"\n+")]
        audio = np.concatenate(chunks) if chunks else np.zeros(2400, dtype=np.float32)
        buf = io.BytesIO()
        sf.write(buf, audio, 24000, format="WAV", subtype="PCM_16")
        print(json.dumps({"id": rid, "b64": base64.b64encode(buf.getvalue()).decode()}), flush=True)
    except Exception as e:
        print(json.dumps({"id": rid, "error": str(e)[:200]}), flush=True)
"#;

/// Chatterbox worker (runs inside the skill's isolated venv): `intensity` maps onto
/// the exaggeration dial; an optional `ref` wav voice-clones the narrator.
/// Chatterbox is ~realtime (≈15 sampling-it/s), so a multi-sentence beat takes tens of
/// seconds — it STREAMS one WAV per sentence (`"more": true` until the last), letting
/// playback start after the first sentence while the rest synthesize.
const CHATTERBOX_PY: &str = r#"
import sys, json, base64, os, re as _re, tempfile
import torch, torchaudio
from chatterbox.tts import ChatterboxTTS
device = "mps" if torch.backends.mps.is_available() else "cpu"
model = ChatterboxTTS.from_pretrained(device=device)
print(json.dumps({"id": "__ready__"}), flush=True)
tmp = tempfile.mkdtemp(prefix="pear-cb-")
def sentences(t):
    parts = [s.strip() for s in _re.split(r"(?<=[.!?])\s+", t) if s.strip()]
    return parts or [t]
for line in sys.stdin:
    rid = "?"
    try:
        req = json.loads(line)
        rid = req["id"]
        kwargs = {"exaggeration": float(req.get("intensity") or 0.5), "cfg_weight": 0.5}
        if req.get("ref"):
            kwargs["audio_prompt_path"] = req["ref"]
        sents = sentences(norm(req["text"]))
        for i, s in enumerate(sents):
            wav = model.generate(s, **kwargs)
            out = os.path.join(tmp, "u.wav")
            torchaudio.save(out, wav.cpu(), model.sr)
            with open(out, "rb") as fh:
                b64 = base64.b64encode(fh.read()).decode()
            os.remove(out)
            print(json.dumps({"id": rid, "b64": b64, "more": i + 1 < len(sents)}), flush=True)
    except Exception as e:
        print(json.dumps({"id": rid, "error": str(e)[:200], "more": False}), flush=True)
"#;

/// Physical memory in GB (macOS: sysctl hw.memsize).
fn physical_mem_gb() -> Option<u64> {
    let out = PCommand::new("sysctl")
        .args(["-n", "hw.memsize"])
        .output()
        .ok()?;
    String::from_utf8_lossy(&out.stdout)
        .trim()
        .parse::<u64>()
        .ok()
        .map(|b| b / 1_073_741_824)
}

/// Where the video-explainer skill provisions its chatterbox venv.
fn chatterbox_python() -> Option<String> {
    let home = std::env::var_os("HOME")?;
    let py =
        std::path::PathBuf::from(home).join(".cache/video-explainer/chatterbox-env/bin/python");
    py.exists().then(|| py.display().to_string())
}

/// A reference voice clip cached by the skill (`ref_<kokoro-voice>.wav`), if present.
fn chatterbox_ref(voice: &str) -> Option<String> {
    let home = std::env::var_os("HOME")?;
    let p = std::path::PathBuf::from(home)
        .join(".cache/video-explainer")
        .join(format!("ref_{voice}.wav"));
    p.exists().then(|| p.display().to_string())
}

pub struct Tts {
    stdin: ChildStdin,
    _child: Child,
    /// Requests written but not yet finally-replied (the pool routes to the least busy).
    pending: Arc<AtomicUsize>,
}

impl Tts {
    pub fn spawn_kokoro(sink: EventSink) -> std::io::Result<Tts> {
        let path = crate::shellenv::login_path();
        let py = ["python3.12", "python3.13", "python3"]
            .iter()
            .map(|p| crate::shellenv::resolve_program(p, path))
            .find(|p| p.contains('/'))
            .unwrap_or_else(|| "python3".to_string());
        Self::spawn(py, format!("{NORM_PY}\n{KOKORO_PY}"), "kokoro", sink)
    }

    pub fn spawn_chatterbox(sink: EventSink) -> std::io::Result<Tts> {
        let py = chatterbox_python().ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "chatterbox env not provisioned (video-explainer --setup-chatterbox)",
            )
        })?;
        Self::spawn(
            py,
            format!("{NORM_PY}\n{CHATTERBOX_PY}"),
            "chatterbox",
            sink,
        )
    }

    fn spawn(
        py: String,
        script: String,
        name: &'static str,
        sink: EventSink,
    ) -> std::io::Result<Tts> {
        let pending = Arc::new(AtomicUsize::new(0));
        let pending_reader = pending.clone();
        // Worker stderr (model-load progress, tracebacks) goes to a log file — the
        // only way to see WHY a worker died. Unique per worker (pools spawn several).
        static WORKER_N: AtomicUsize = AtomicUsize::new(0);
        let n = WORKER_N.fetch_add(1, Ordering::Relaxed);
        let log = std::fs::File::create(format!("/tmp/pear-tts-{name}-{n}.log"))
            .map(Stdio::from)
            .unwrap_or_else(|_| Stdio::null());
        let mut child = PCommand::new(&py)
            .args(["-u", "-c", &script])
            .env("PATH", crate::shellenv::login_path())
            // MPS occasionally SIGBUSes under GPU contention (the WebGL galaxy shares
            // the GPU); let unsupported/flaky ops fall back to CPU instead of dying.
            .env("PYTORCH_ENABLE_MPS_FALLBACK", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(log)
            .spawn()?;
        let stdin = child.stdin.take().expect("piped stdin");
        let stdout = child.stdout.take().expect("piped stdout");
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                let Ok(line) = line else { break };
                // Libraries may chat on stdout — only honor well-formed worker replies.
                let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else {
                    continue;
                };
                let id = v["id"].as_str().unwrap_or_default().to_string();
                if id == "__ready__" || id.is_empty() {
                    continue;
                }
                let wav = v["b64"].as_str().unwrap_or_default().to_string();
                if wav.is_empty() {
                    sink(Event::Notice {
                        tab: None,
                        message: format!(
                            "tts({name}): {}",
                            v["error"].as_str().unwrap_or("synthesis failed")
                        ),
                    });
                }
                let more = v["more"].as_bool().unwrap_or(false);
                if !more {
                    pending_reader.fetch_sub(1, Ordering::Relaxed);
                }
                sink(Event::Speech {
                    id,
                    wav_b64: wav,
                    more,
                });
            }
            // EOF: worker died (missing deps, crash). The engine reroutes the NEXT
            // request; in-flight ones are covered by the frontend's fallback timer.
            sink(Event::Notice {
                tab: None,
                message: format!("tts({name}) worker exited"),
            });
        });
        Ok(Tts {
            stdin,
            _child: child,
            pending,
        })
    }

    /// Queue one utterance. An I/O error means the worker is gone.
    pub fn speak(
        &mut self,
        id: &str,
        text: &str,
        intensity: Option<f32>,
        voice: Option<&str>,
    ) -> std::io::Result<()> {
        let req = serde_json::json!({
            "id": id,
            "text": text,
            "intensity": intensity,
            "voice": voice,
            "ref": voice.and_then(chatterbox_ref),
        });
        writeln!(self.stdin, "{req}")?;
        self.stdin.flush()?;
        self.pending.fetch_add(1, Ordering::Relaxed);
        Ok(())
    }
}

/// A pool of chatterbox workers — the model is ~realtime, so parallel workers cut the
/// journey-preload wall clock (sub-linearly: they share the GPU, but CPU/GPU phases
/// overlap). Requests route to the least-busy live worker; dead workers are skipped.
/// Size: `PEAR_TTS_POOL` (default 4). Each worker holds its own model copy (~2-3 GB).
pub struct TtsPool {
    workers: Vec<Tts>,
}

impl TtsPool {
    /// Pool size: `PEAR_TTS_POOL` override, else scaled to physical memory — each
    /// worker holds a ~3 GB model copy, and over-provisioning froze a 64 GB machine
    /// once the rest of the system had eaten its share.
    pub fn pool_size() -> usize {
        if let Some(n) = std::env::var("PEAR_TTS_POOL")
            .ok()
            .and_then(|v| v.parse().ok())
            .filter(|n| (1..=8).contains(n))
        {
            return n;
        }
        let gb = physical_mem_gb().unwrap_or(16);
        match gb {
            g if g >= 96 => 4,
            g if g >= 48 => 3,
            g if g >= 24 => 2,
            _ => 1,
        }
    }

    /// Spawn the pool (model loads run in parallel). Errors only if NO worker starts.
    pub fn spawn_chatterbox(sink: EventSink) -> std::io::Result<TtsPool> {
        let mut workers = Vec::new();
        let mut last_err = None;
        for _ in 0..Self::pool_size() {
            match Tts::spawn_chatterbox(sink.clone()) {
                Ok(t) => workers.push(t),
                Err(e) => last_err = Some(e),
            }
        }
        if workers.is_empty() {
            return Err(
                last_err.unwrap_or_else(|| std::io::Error::other("no chatterbox workers started"))
            );
        }
        Ok(TtsPool { workers })
    }

    /// Route to the least-busy worker; a write failure marks that worker dead and the
    /// next one is tried. Errors only when every worker is gone.
    pub fn speak(
        &mut self,
        id: &str,
        text: &str,
        intensity: Option<f32>,
        voice: Option<&str>,
    ) -> std::io::Result<()> {
        while !self.workers.is_empty() {
            let i = self
                .workers
                .iter()
                .enumerate()
                .min_by_key(|(_, w)| w.pending.load(Ordering::Relaxed))
                .map(|(i, _)| i)
                .unwrap_or(0);
            if self.workers[i].speak(id, text, intensity, voice).is_ok() {
                return Ok(());
            }
            self.workers.remove(i); // dead — try the next-least-busy
        }
        Err(std::io::Error::other("all chatterbox workers dead"))
    }
}
