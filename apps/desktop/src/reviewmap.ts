// The peaRview review map — a WebGL review GALAXY (step 3 of docs/PEARVIEW.md).
//
// The visual grammar is IDENTICAL every review (that consistency is the v1 learning
// model), now rendered as a three.js scene with bloom post-processing:
//   · the VERDICT is the sun — its color/glow is the review's state, pulsing gently
//   · each walkthrough BEAT is a planet on an orbit ring (ring # = narrative order,
//     planet size/ring color = risk)
//   · each FINDING is a moon of its beat-planet, placed on a golden-angle spherical
//     Fibonacci lattice (the same phyllotaxis law at every scale — moons around
//     planets now, subject-clusters around the group core in tandem mode later)
//   · hue = type · size = severity · emissive = confidence · pulsing = blocker ·
//     precessing ring = engine-disputed · wireframe = question · green = praise
// Click a moon → the detail card (evidence, the rule's teaching block, committable
// patch, engine attribution, anchor-jump; questions get the reply-to-terminal box).
// Drag to orbit, scroll to zoom. reduce-motion freezes all idle motion.

import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import {
  CSS2DObject,
  CSS2DRenderer,
} from "three/examples/jsm/renderers/CSS2DRenderer.js";
import type { RdFinding, ReviewDoc } from "./protocol";

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5)); // radians

// type → hue. ONE table (display-layer remap path to fewer buckets — spec decision).
// Evolvability types sit in the warm-neutral band so the empirical 75% doesn't scream.
const TYPE_COLOR: Record<string, number> = {
  bug: 0xf85149,
  security: 0xff5d8f,
  error_handling: 0xf0883e,
  test: 0xe3b341,
  api: 0x58a6ff,
  design: 0xa371f7,
  compat: 0x8e96f0,
  perf: 0x56d4dd,
  observability: 0x39c5cf,
  docs: 0x9e9784,
  clarity: 0xc9b890,
  style: 0x8b949e,
  question: 0x7ee787,
  praise: 0x3fb950,
};
const SEV_SIZE: Record<string, number> = {
  blocker: 0.4,
  fix_before_merge: 0.32,
  follow_up: 0.25,
  take_or_leave: 0.19,
};
const SEV_GLYPH: Record<string, string> = {
  blocker: "⛔",
  fix_before_merge: "🔶",
  follow_up: "⏳",
  take_or_leave: "💭",
};
const RISK_COLOR: Record<string, number> = {
  low: 0x6e7681,
  medium: 0xd29922,
  high: 0xf85149,
};
const RISK_SIZE: Record<string, number> = { low: 0.5, medium: 0.62, high: 0.76 };
const VERDICT_COLOR: Record<string, number> = {
  ready: 0x3fb950,
  ready_with_nits: 0x7ee787,
  needs_work: 0xd29922,
  blocked: 0xf85149,
};
const VERDICT_LABEL: Record<string, string> = {
  ready: "✅ ready",
  ready_with_nits: "✅ ready · with nits",
  needs_work: "🔧 needs work",
  blocked: "⛔ blocked",
};

export interface MapCallbacks {
  /** Jump the diff panel to an anchor. */
  onJump: (path: string, line: number | null) => void;
  /** Send a question-reply into the tab's agent terminal. */
  onAsk: (finding: RdFinding, text: string) => void;
  reduceMotion: boolean;
  /** Canvas height in px (the pop-out theater passes the full window). Default 470. */
  stageHeight?: number;
}

/** Handle the journey (guided tour) drives: camera flights, focus-follow, selection
 *  rings, journey mode (idle motion paused for stable framing). */
export interface MapHandle {
  /** Fly to + follow an object (moon/planet/sun); `dist` = orbit distance. */
  focus: (obj: THREE.Object3D, dist: number) => void;
  /** Fly back to the wide establishing shot. */
  focusWide: () => void;
  /** Pause orbital motion (and auto-rotate) for stable framing. */
  setJourneyMode: (on: boolean) => void;
  moonOf: (findingId: string) => THREE.Object3D | undefined;
  planetAt: (beatIndex: number) => THREE.Object3D | undefined;
  sunObj: () => THREE.Object3D;
  /** Toggle the gold "in your review" shell on a finding's moon. */
  setSelected: (findingId: string, on: boolean) => void;
  /** Open the detail card for a finding (same card the click path uses). */
  showDetail: (f: RdFinding) => void;
}

// One live scene at a time — torn down before every render (and when detached).
let teardown: (() => void) | null = null;

/** Dock each finding to the beat whose anchors best match its anchor (path → dir). */
function dockFindings(doc: ReviewDoc): Map<number, RdFinding[]> {
  const beats = doc.understanding.walkthrough;
  const out = new Map<number, RdFinding[]>();
  const dirOf = (p: string) => p.split("/").slice(0, -1).join("/");
  for (const f of doc.findings) {
    let best = -1;
    if (f.anchor) {
      best = beats.findIndex((b) => b.anchors.some((a) => a.path === f.anchor!.path));
      if (best < 0)
        best = beats.findIndex((b) =>
          b.anchors.some((a) => dirOf(a.path) === dirOf(f.anchor!.path)),
        );
    }
    if (best < 0) best = beats.length; // trailing "everything else" planet
    (out.get(best) ?? out.set(best, []).get(best)!).push(f);
  }
  return out;
}

/** Spherical Fibonacci lattice point j of n on a sphere of radius r. */
function sphereFib(j: number, n: number, r: number): THREE.Vector3 {
  const y = n === 1 ? 0 : 1 - (2 * (j + 0.5)) / n;
  const ring = Math.sqrt(Math.max(0, 1 - y * y));
  const theta = GOLDEN_ANGLE * j;
  return new THREE.Vector3(Math.cos(theta) * ring * r, y * r, Math.sin(theta) * ring * r);
}

export function renderReviewMap(
  host: HTMLElement,
  doc: ReviewDoc,
  warnings: string[],
  cb: MapCallbacks,
): MapHandle {
  teardown?.();
  host.innerHTML = "";
  const root = document.createElement("div");
  root.className = "rmap";

  // ── verdict strip(s) + purpose: readable text stays HTML ──
  const state0 = doc.verdict.per_subject[0]?.state ?? "ready";
  for (const v of doc.verdict.per_subject) {
    const subj = doc.subjects[v.subject];
    const strip = document.createElement("div");
    strip.className = `rmap-verdict rmap-${v.state}`;
    const ledger = Object.entries(doc.verdict.ledger)
      .filter(([k, n]) => n > 0 && SEV_GLYPH[k])
      .map(([k, n]) => `${n}${SEV_GLYPH[k]}`)
      .join(" ");
    strip.innerHTML = `<b>${VERDICT_LABEL[v.state] ?? v.state}</b><span class="rmap-vref">${subj?.ref ??
      ""}</span><span class="rmap-vledger">${ledger}</span>`;
    if (v.justification) strip.title = v.justification;
    root.appendChild(strip);
    if (v.scope) {
      const sc = document.createElement("div");
      sc.className = "rmap-scope";
      sc.textContent = `pass scope: ${v.scope}`;
      root.appendChild(sc);
    }
  }
  const purpose = document.createElement("div");
  purpose.className = "rmap-purpose";
  purpose.textContent = doc.understanding.purpose;
  root.appendChild(purpose);

  // ── the galaxy ──
  const stage = document.createElement("div");
  stage.className = "rmap-stage";
  root.appendChild(stage);

  const W = Math.max(host.clientWidth || 460, 340) - 24;
  const H = cb.stageHeight ?? 470;
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(W, H);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  stage.appendChild(renderer.domElement);

  const labelRenderer = new CSS2DRenderer();
  labelRenderer.setSize(W, H);
  labelRenderer.domElement.className = "rmap-labels";
  stage.appendChild(labelRenderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x05070c);
  scene.fog = new THREE.FogExp2(0x05070c, 0.016);

  const camera = new THREE.PerspectiveCamera(50, W / H, 0.1, 200);
  camera.position.set(0, 7.5, 16);

  const controls = new OrbitControls(camera, labelRenderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.06;
  controls.enablePan = false;
  controls.minDistance = 4;
  controls.maxDistance = 40;
  controls.autoRotate = !cb.reduceMotion;
  controls.autoRotateSpeed = 0.35;

  scene.add(new THREE.AmbientLight(0x8899bb, 0.55));
  const sunColor = VERDICT_COLOR[state0] ?? 0x3fb950;
  const sunLight = new THREE.PointLight(0xffffff, 60, 0, 1.8);
  scene.add(sunLight);

  // Starfield.
  {
    const n = 1400;
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const v = new THREE.Vector3()
        .randomDirection()
        .multiplyScalar(28 + Math.random() * 32);
      pos.set([v.x, v.y, v.z], i * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    const m = new THREE.PointsMaterial({
      color: 0x99aacc,
      size: 0.06,
      transparent: true,
      opacity: 0.7,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    scene.add(new THREE.Points(g, m));
  }

  // The verdict sun.
  const sun = new THREE.Mesh(
    new THREE.IcosahedronGeometry(1.05, 3),
    new THREE.MeshStandardMaterial({
      color: sunColor,
      emissive: sunColor,
      emissiveIntensity: 2.2,
      roughness: 0.35,
    }),
  );
  scene.add(sun);
  const corona = new THREE.Mesh(
    new THREE.IcosahedronGeometry(1.45, 3),
    new THREE.MeshBasicMaterial({
      color: sunColor,
      transparent: true,
      opacity: 0.14,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  );
  scene.add(corona);

  // Planets (beats) + moons (findings).
  interface Spin {
    obj: THREE.Object3D;
    speed: number;
  }
  const spins: Spin[] = [];
  const pulses: THREE.Mesh[] = [];
  const precess: THREE.Mesh[] = [];
  const pickables: THREE.Object3D[] = [];
  const intro: { obj: THREE.Object3D; at: number }[] = [];
  // Journey machinery: finding-id → moon, beat-index → planet, selection shells.
  const moonById = new Map<string, THREE.Object3D>();
  const planetByIdx: THREE.Object3D[] = [];
  const selShells = new Map<string, THREE.Mesh>();
  let journeyPaused = false;
  // Camera focus: follow `obj` (or a fixed point); the flight lerps the camera in for
  // `flight` seconds, after which the user orbits freely while the target stays pinned.
  let focusState: { obj: THREE.Object3D | null; pos: THREE.Vector3; dist: number; flight: number } | null =
    null;

  const docked = dockFindings(doc);
  const beats = [...doc.understanding.walkthrough.map((b) => ({ title: b.title, body: b.body, risk: b.risk }))];
  if (docked.has(beats.length) || beats.length === 0)
    beats.push({ title: beats.length ? "other findings" : "findings", body: "", risk: "low" });

  let introT = 0.25;
  beats.forEach((beat, i) => {
    const orbitR = 3.4 + i * 2.0;
    // Orbit ring.
    const ringGeo = new THREE.BufferGeometry().setFromPoints(
      Array.from({ length: 129 }, (_, k) => {
        const a = (k / 128) * Math.PI * 2;
        return new THREE.Vector3(Math.cos(a) * orbitR, 0, Math.sin(a) * orbitR);
      }),
    );
    scene.add(
      new THREE.Line(
        ringGeo,
        new THREE.LineBasicMaterial({ color: 0x30363d, transparent: true, opacity: 0.55 }),
      ),
    );

    const orbit = new THREE.Group(); // rotates → the planet revolves
    orbit.rotation.y = i * 1.7; // deterministic phase
    scene.add(orbit);
    spins.push({ obj: orbit, speed: 0.05 / (1 + i * 0.6) });

    const planetGroup = new THREE.Group();
    planetGroup.position.x = orbitR;
    orbit.add(planetGroup);

    const pr = RISK_SIZE[beat.risk] ?? 0.5;
    const pc = RISK_COLOR[beat.risk] ?? 0x6e7681;
    const planet = new THREE.Mesh(
      new THREE.IcosahedronGeometry(pr, 2),
      new THREE.MeshStandardMaterial({
        color: 0x21262d,
        emissive: pc,
        emissiveIntensity: 0.5,
        roughness: 0.5,
      }),
    );
    planet.userData.beat = beat;
    planetGroup.add(planet);
    pickables.push(planet);
    planetByIdx.push(planetGroup);
    intro.push({ obj: planetGroup, at: introT });
    introT += 0.12;

    // Beat label (always faces camera; counter-rotation not needed with CSS2D).
    const labelEl = document.createElement("div");
    labelEl.className = "rmap3d-label";
    labelEl.textContent = `${i + 1} · ${beat.title}`;
    if (beat.body) labelEl.title = beat.body;
    const label = new CSS2DObject(labelEl);
    label.position.set(0, pr + 0.55, 0);
    planetGroup.add(label);

    // Moons on a spherical Fibonacci lattice (severity-major: big moons sit closest).
    const moons = (docked.get(i) ?? [])
      .slice()
      .sort((a, b) => (SEV_SIZE[b.severity] ?? 0.2) - (SEV_SIZE[a.severity] ?? 0.2));
    const moonOrbit = new THREE.Group();
    planetGroup.add(moonOrbit);
    spins.push({ obj: moonOrbit, speed: 0.28 / (1 + i * 0.25) });
    moons.forEach((f, j) => {
      const dist = pr + 0.75 + 0.22 * Math.sqrt(j);
      const p = sphereFib(j, moons.length, dist);
      const size = SEV_SIZE[f.severity] ?? 0.2;
      const color = TYPE_COLOR[f.type] ?? 0x8b949e;
      const conf = Math.max(0, Math.min(1, f.confidence ?? 1));
      const isQ = f.type === "question";
      const mat = new THREE.MeshStandardMaterial({
        color: isQ ? 0x0d1117 : color,
        emissive: color,
        emissiveIntensity: (f.severity === "blocker" ? 2.6 : f.severity === "fix_before_merge" ? 1.8 : 0.9) * (0.35 + 0.65 * conf),
        roughness: 0.4,
        wireframe: isQ,
        transparent: f.status !== "open",
        opacity: f.status !== "open" ? 0.3 : 1,
      });
      const moon = new THREE.Mesh(new THREE.IcosahedronGeometry(size, 2), mat);
      moon.position.copy(p);
      moon.userData.finding = f;
      moonOrbit.add(moon);
      pickables.push(moon);
      moonById.set(f.id, moon);
      intro.push({ obj: moon, at: introT + j * 0.06 });
      if (f.severity === "blocker") pulses.push(moon);
      // Engine-disputed → a precessing ring around the moon.
      if (Object.values(f.engines).includes("dispute")) {
        const ring = new THREE.Mesh(
          new THREE.TorusGeometry(size + 0.14, 0.018, 8, 48),
          new THREE.MeshBasicMaterial({
            color,
            transparent: true,
            opacity: 0.85,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
          }),
        );
        ring.rotation.x = Math.PI / 2.6;
        moon.add(ring);
        precess.push(ring);
      }
    });
    introT += 0.1;
  });

  // Post-processing: bloom is what makes it glow.
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(W, H), 1.15, 0.65, 0.18);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  // Picking.
  const ray = new THREE.Raycaster();
  const mouse = new THREE.Vector2();
  let hovered: THREE.Object3D | null = null;
  const detail = buildDetailCard(root, cb);
  const pick = (ev: PointerEvent): THREE.Object3D | null => {
    const r = renderer.domElement.getBoundingClientRect();
    mouse.set(((ev.clientX - r.left) / r.width) * 2 - 1, (-(ev.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(mouse, camera);
    const hit = ray.intersectObjects(pickables, false)[0];
    return hit?.object ?? null;
  };
  labelRenderer.domElement.addEventListener("pointermove", (ev) => {
    const o = pick(ev);
    if (hovered && hovered !== o) hovered.scale.setScalar(1);
    hovered = o;
    if (o) o.scale.setScalar(1.25);
    labelRenderer.domElement.style.cursor = o ? "pointer" : "grab";
  });
  labelRenderer.domElement.addEventListener("pointerdown", (ev) => {
    const o = pick(ev);
    const f = o?.userData.finding as RdFinding | undefined;
    if (f) detail.show(f);
  });

  // ── animation loop ──
  const clock = new THREE.Clock();
  let raf = 0;
  let elapsed = 0;
  const camStart = camera.position.clone().multiplyScalar(1.8);
  const camEnd = camera.position.clone();
  const tick = () => {
    if (!renderer.domElement.isConnected) return dispose(); // panel content replaced
    raf = requestAnimationFrame(tick);
    const dt = clock.getDelta();
    elapsed += dt;
    // Intro: camera dolly + staggered scale-in.
    if (!cb.reduceMotion && elapsed < 1.4) {
      const t = Math.min(elapsed / 1.4, 1);
      const e = 1 - Math.pow(1 - t, 3);
      camera.position.lerpVectors(camStart, camEnd, e);
    }
    for (const it of intro) {
      const t = cb.reduceMotion ? 1 : Math.max(0, Math.min((elapsed - it.at) / 0.45, 1));
      const e = 1 - Math.pow(1 - t, 3);
      it.obj.scale.setScalar(Math.max(e, 0.0001));
    }
    if (!cb.reduceMotion) {
      // Orbital revolution pauses during a journey so the framed object holds still;
      // the "alive" motion (breathing, pulses, precession) keeps going.
      if (!journeyPaused) for (const s of spins) s.obj.rotation.y += s.speed * dt;
      const breathe = 1 + Math.sin(elapsed * 1.7) * 0.04;
      sun.scale.setScalar(breathe);
      corona.scale.setScalar(breathe * (1 + Math.sin(elapsed * 0.9) * 0.06));
      for (const m of pulses) {
        const mat = m.material as THREE.MeshStandardMaterial;
        mat.emissiveIntensity = 2.2 + Math.sin(elapsed * 3.2) * 1.0;
      }
      for (const r of precess) {
        r.rotation.z += dt * 0.9;
        r.rotation.x += dt * 0.35;
      }
      for (const s of selShells.values()) s.rotation.y += dt * 0.8;
    }
    // Camera focus-follow: target tracks the focused object every frame; the camera
    // itself only flies during the flight window, then the user orbits freely.
    if (focusState) {
      const tp = new THREE.Vector3();
      if (focusState.obj) focusState.obj.getWorldPosition(tp);
      else tp.copy(focusState.pos);
      const k = 1 - Math.exp(-dt * 4.2);
      controls.target.lerp(tp, k);
      if (focusState.flight > 0) {
        focusState.flight -= dt;
        const dir = camera.position.clone().sub(tp);
        dir.normalize().multiplyScalar(focusState.dist);
        dir.y += focusState.dist * 0.18; // slight crane for a cinematic angle
        camera.position.lerp(tp.clone().add(dir), k);
      }
    }
    controls.update();
    composer.render();
    labelRenderer.render(scene, camera);
  };

  // Resize with the panel.
  const ro = new ResizeObserver(() => {
    const w = Math.max(host.clientWidth - 24, 280);
    camera.aspect = w / H;
    camera.updateProjectionMatrix();
    renderer.setSize(w, H);
    composer.setSize(w, H);
    labelRenderer.setSize(w, H);
  });
  ro.observe(host);

  const dispose = () => {
    cancelAnimationFrame(raf);
    ro.disconnect();
    controls.dispose();
    scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
      const mat = m.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
      else mat?.dispose();
    });
    composer.dispose();
    renderer.dispose();
    teardown = null;
  };
  teardown = dispose;

  // ── footer ──
  if (doc.understanding.verified.length) {
    const v = document.createElement("div");
    v.className = "rmap-verified";
    v.textContent = `verified: ${doc.understanding.verified.join(" · ")}`;
    root.appendChild(v);
  }
  if (warnings.length) {
    const w = document.createElement("div");
    w.className = "rmap-warnings";
    w.textContent = `⚠ ${warnings.join("; ")}`;
    root.appendChild(w);
  }
  // Attach BEFORE the first tick — the loop's liveness check is `isConnected`, so
  // starting it pre-attach would dispose the scene on frame one (black canvas).
  host.appendChild(root);
  tick();

  return {
    focus(obj, dist) {
      focusState = { obj, pos: new THREE.Vector3(), dist, flight: 1.6 };
    },
    focusWide() {
      focusState = { obj: null, pos: new THREE.Vector3(0, 0, 0), dist: 16, flight: 1.6 };
    },
    setJourneyMode(on) {
      journeyPaused = on;
      controls.autoRotate = !on && !cb.reduceMotion;
      if (!on) focusState = null;
    },
    moonOf: (id) => moonById.get(id),
    planetAt: (i) => planetByIdx[i],
    sunObj: () => sun,
    setSelected(id, on) {
      const moon = moonById.get(id) as THREE.Mesh | undefined;
      if (!moon) return;
      const existing = selShells.get(id);
      if (!on) {
        if (existing) {
          moon.remove(existing);
          existing.geometry.dispose();
          (existing.material as THREE.Material).dispose();
          selShells.delete(id);
        }
        return;
      }
      if (existing) return;
      const r = (moon.geometry as THREE.IcosahedronGeometry).parameters.radius ?? 0.25;
      const shell = new THREE.Mesh(
        new THREE.IcosahedronGeometry(r + 0.12, 1),
        new THREE.MeshBasicMaterial({
          color: 0xffd866,
          wireframe: true,
          transparent: true,
          opacity: 0.85,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
      );
      moon.add(shell);
      selShells.set(id, shell);
    },
    showDetail: (f) => detail.show(f),
  };
}

/** The click-through detail card: evidence, the rule's teaching block, the committable
 *  patch, engine attribution — and for questions, the v1 reply-into-terminal box. */
function buildDetailCard(root: HTMLElement, cb: MapCallbacks) {
  const card = document.createElement("div");
  card.className = "rmap-card hidden";
  root.appendChild(card);
  const hide = () => card.classList.add("hidden");
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hide();
  });
  return {
    show(f: RdFinding) {
      card.innerHTML = "";
      const color = `#${(TYPE_COLOR[f.type] ?? 0x8b949e).toString(16).padStart(6, "0")}`;
      const head = document.createElement("div");
      head.className = "rmap-card-head";
      head.innerHTML = `<span class="rmap-dot" style="background:${color}"></span><b>${SEV_GLYPH[f.severity] ?? ""} ${escapeText(
        f.title,
      )}</b><button class="rmap-x">✕</button>`;
      head.querySelector(".rmap-x")!.addEventListener("click", hide);
      card.appendChild(head);
      const meta = document.createElement("div");
      meta.className = "rmap-card-meta";
      const bits = [
        `[${f.type}]`,
        f.severity.replace(/_/g, " "),
        `confidence ${Math.round((f.confidence ?? 1) * 100)}%`,
      ];
      for (const [e, verd] of Object.entries(f.engines)) bits.push(`${e}:${verd}`);
      if (f.status !== "open") bits.push(`status: ${f.status}`);
      meta.textContent = bits.join("  ·  ");
      card.appendChild(meta);
      if (f.anchor) {
        const a = document.createElement("button");
        a.className = "rmap-anchor";
        a.textContent = `↗ ${f.anchor.path}${f.anchor.line ? `:${f.anchor.line}` : ""}`;
        const anchor = f.anchor;
        a.addEventListener("click", () => cb.onJump(anchor.path, anchor.line));
        card.appendChild(a);
      }
      if (f.evidence) {
        const ev = document.createElement("div");
        ev.className = "rmap-card-evidence";
        ev.textContent = f.evidence;
        card.appendChild(ev);
      }
      if (f.rule?.why) {
        const why = document.createElement("div");
        why.className = "rmap-card-why";
        why.innerHTML = `<b>why this matters</b><br>`;
        why.append(f.rule.why);
        card.appendChild(why);
      }
      if (f.suggestion?.patch) {
        const pre = document.createElement("pre");
        pre.className = "rmap-card-patch";
        pre.textContent = f.suggestion.patch;
        const copy = document.createElement("button");
        copy.className = "rmap-copy";
        copy.textContent = "copy patch";
        copy.addEventListener("click", () => {
          void navigator.clipboard.writeText(f.suggestion!.patch);
          copy.textContent = "copied ✓";
        });
        card.appendChild(pre);
        card.appendChild(copy);
      }
      if (f.type === "question") {
        const row = document.createElement("div");
        row.className = "rmap-ask";
        const input = document.createElement("input");
        input.placeholder = "answer / ask the agent about this…";
        const go = document.createElement("button");
        go.textContent = "⏎ to terminal";
        const fire = () => {
          if (!input.value.trim()) return;
          cb.onAsk(f, input.value.trim());
          input.value = "";
          hide();
        };
        go.addEventListener("click", fire);
        input.addEventListener("keydown", (e) => {
          if (e.key === "Enter") fire();
        });
        row.append(input, go);
        card.appendChild(row);
      }
      card.classList.remove("hidden");
    },
  };
}

function escapeText(s: string): string {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}
