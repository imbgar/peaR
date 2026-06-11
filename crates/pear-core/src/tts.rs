//! Local TTS for the review journey — a persistent Kokoro-82M worker (the proven
//! fast backend from the video-explainer skill: ~9× realtime on CPU after a one-time
//! ~2s model load, ~500 MB RSS), spoken to over JSON lines on stdin/stdout.
//!
//! `Command::Speak { id, text }` → worker synth → `Event::Speech { id, wav_b64 }`.
//! Failure surfaces as an empty final `Event::Speech` (+ a Notice once), so the
//! frontend falls back to the webview's system voice without stalling.
//!
//! (A Chatterbox emotion-dial backend lived here briefly — its multi-gigabyte model
//! pool exhausted unified memory and froze the machine twice. Removed; see git
//! history `feat(pearview): chatterbox…` if it's ever revisited on bigger hardware.)

use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command as PCommand, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};

use crate::protocol::Event;
use crate::session::EventSink;

/// Kokoro worker: loads once, normalizes text (the skill's rule: pre-expand
/// numbers/symbols), synthesizes each request to a 16-bit 24 kHz WAV, base64 out.
const KOKORO_PY: &str = r#"
import sys, json, io, base64, re
import numpy as np
import soundfile as sf
from kokoro import KPipeline
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
        // Worker stderr (model-load progress, tracebacks) goes to a log file — the
        // only way to see WHY a worker died.
        static WORKER_N: AtomicUsize = AtomicUsize::new(0);
        let n = WORKER_N.fetch_add(1, Ordering::Relaxed);
        let log = std::fs::File::create(format!("/tmp/pear-tts-kokoro-{n}.log"))
            .map(Stdio::from)
            .unwrap_or_else(|_| Stdio::null());
        let mut child = PCommand::new(&py)
            .args(["-u", "-c", KOKORO_PY])
            .env("PATH", path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(log)
            .spawn()?;
        let stdin = child.stdin.take().expect("piped stdin");
        let stdout = child.stdout.take().expect("piped stdout");
        let sink_reader = sink.clone();
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
                    sink_reader(Event::Notice {
                        tab: None,
                        message: format!(
                            "tts: {}",
                            v["error"].as_str().unwrap_or("synthesis failed")
                        ),
                    });
                }
                sink_reader(Event::Speech {
                    id,
                    wav_b64: wav,
                    more: false,
                });
            }
            // EOF: the worker died (missing deps, crash, idle-reaped). The engine
            // respawns on the next request; in-flight ones are covered by the
            // frontend's fallback timer.
            sink_reader(Event::Notice {
                tab: None,
                message: "tts worker exited".into(),
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
