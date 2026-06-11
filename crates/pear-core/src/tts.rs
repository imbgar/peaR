//! Local TTS for the review journey — a persistent Kokoro-82M worker (the proven
//! fast backend from the video-explainer skill: ~9× realtime on CPU after a one-time
//! ~2s model load), spoken to over JSON lines on stdin/stdout.
//!
//! `Command::Speak { id, text }` → worker synth → `Event::Speech { id, wav_b64 }`.
//! Failure surfaces as `Event::Speech` with an empty `wav_b64` (+ a Notice once), so
//! the frontend can fall back to the webview's speechSynthesis without stalling.

use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command as PCommand, Stdio};

use crate::protocol::Event;
use crate::session::EventSink;

/// JSON-lines worker: loads Kokoro ONCE, then synthesizes each request to a 16-bit
/// 24 kHz WAV, base64 on stdout. Light text normalization (the skill's rule: Kokoro
/// wants pre-expanded numbers/symbols). Non-JSON stdout lines are ignored reader-side.
const WORKER_PY: &str = r#"
import sys, json, io, base64, re
import numpy as np
import soundfile as sf
from kokoro import KPipeline
pipe = KPipeline(lang_code="a", repo_id="hexgrad/Kokoro-82M")
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

pub struct Tts {
    stdin: ChildStdin,
    _child: Child,
}

impl Tts {
    /// Spawn the worker and a reader thread that turns its output lines into
    /// `Event::Speech`. Returns an error if no python with kokoro is startable
    /// (the import error itself arrives async via the reader's EOF → Notice).
    pub fn spawn(sink: EventSink) -> std::io::Result<Tts> {
        let path = crate::shellenv::login_path();
        let py = ["python3.12", "python3.13", "python3"]
            .iter()
            .map(|p| crate::shellenv::resolve_program(p, path))
            .find(|p| p.contains('/'))
            .unwrap_or_else(|| "python3".to_string());
        let mut child = PCommand::new(&py)
            .args(["-u", "-c", WORKER_PY])
            .env("PATH", path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null()) // model-load progress bars etc.
            .spawn()?;
        let stdin = child.stdin.take().expect("piped stdin");
        let stdout = child.stdout.take().expect("piped stdout");
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            let mut ready = false;
            for line in reader.lines() {
                let Ok(line) = line else { break };
                // kokoro/hf may chat on stdout — only honor well-formed worker replies.
                let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else {
                    continue;
                };
                let id = v["id"].as_str().unwrap_or_default().to_string();
                if id == "__ready__" {
                    ready = true;
                    continue;
                }
                if id.is_empty() {
                    continue;
                }
                let wav = v["b64"].as_str().unwrap_or_default().to_string();
                if wav.is_empty() {
                    sink(Event::Notice {
                        tab: None,
                        message: format!(
                            "tts: {}",
                            v["error"].as_str().unwrap_or("synthesis failed")
                        ),
                    });
                }
                sink(Event::Speech { id, wav_b64: wav });
            }
            // EOF: the worker died (missing deps, crash). Tell the frontend once so
            // narration falls back to the system voice.
            sink(Event::Notice {
                tab: None,
                message: if ready {
                    "tts worker exited — narration falls back to the system voice".into()
                } else {
                    "tts unavailable (python kokoro not importable) — narration falls back \
                     to the system voice"
                        .into()
                },
            });
            sink(Event::Speech {
                id: "__dead__".into(),
                wav_b64: String::new(),
            });
        });
        Ok(Tts {
            stdin,
            _child: child,
        })
    }

    /// Queue one utterance. An I/O error means the worker is gone.
    pub fn speak(&mut self, id: &str, text: &str) -> std::io::Result<()> {
        let req = serde_json::json!({ "id": id, "text": text });
        writeln!(self.stdin, "{req}")?;
        self.stdin.flush()
    }
}
