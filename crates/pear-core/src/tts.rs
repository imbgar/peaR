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
const CHATTERBOX_PY: &str = r#"
import sys, json, base64, os, tempfile
import torch, torchaudio
from chatterbox.tts import ChatterboxTTS
device = "mps" if torch.backends.mps.is_available() else "cpu"
model = ChatterboxTTS.from_pretrained(device=device)
print(json.dumps({"id": "__ready__"}), flush=True)
tmp = tempfile.mkdtemp(prefix="pear-cb-")
for line in sys.stdin:
    rid = "?"
    try:
        req = json.loads(line)
        rid = req["id"]
        kwargs = {"exaggeration": float(req.get("intensity") or 0.5), "cfg_weight": 0.5}
        if req.get("ref"):
            kwargs["audio_prompt_path"] = req["ref"]
        wav = model.generate(norm(req["text"]), **kwargs)
        out = os.path.join(tmp, "u.wav")
        torchaudio.save(out, wav.cpu(), model.sr)
        with open(out, "rb") as fh:
            b64 = base64.b64encode(fh.read()).decode()
        os.remove(out)
        print(json.dumps({"id": rid, "b64": b64}), flush=True)
    except Exception as e:
        print(json.dumps({"id": rid, "error": str(e)[:200]}), flush=True)
"#;

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
        // Worker stderr (model-load progress, tracebacks) goes to a log file — the
        // only way to see WHY a worker died.
        let log = std::fs::File::create(format!("/tmp/pear-tts-{name}.log"))
            .map(Stdio::from)
            .unwrap_or_else(|_| Stdio::null());
        let mut child = PCommand::new(&py)
            .args(["-u", "-c", &script])
            .env("PATH", crate::shellenv::login_path())
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
                sink(Event::Speech { id, wav_b64: wav });
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
        self.stdin.flush()
    }
}
