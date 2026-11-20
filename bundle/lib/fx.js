/* Pixel Trivia — chiptune sound effects (WebAudio), the falling-star background and pixel bursts.
   Carried over from the original prototype. */

export const RM = matchMedia("(prefers-reduced-motion: reduce)").matches;

/* ---------- sound ---------- */
let AC = null, muted = false;
export const setMuted = m => { muted = !!m; };
function beep(f, d, t, delay, v){
  if (muted) return;
  try {
    AC = AC || new (window.AudioContext || window.webkitAudioContext)();
    if (AC.state === "suspended") AC.resume().catch(() => {});
    const o = AC.createOscillator(), g = AC.createGain(), s = AC.currentTime + (delay || 0);
    o.type = t || "square"; o.frequency.setValueAtTime(f, s);
    g.gain.setValueAtTime(v || .08, s); g.gain.exponentialRampToValueAtTime(.001, s + d);
    o.connect(g); g.connect(AC.destination); o.start(s); o.stop(s + d);
  } catch(e){}
}
export const SFX = {
  click(){ beep(520, .06); },
  good(){ [523, 659, 784, 1047].forEach((f, i) => beep(f, .12, "square", i * .07)); },
  bad(){ beep(180, .18, "sawtooth", 0, .1); beep(120, .3, "sawtooth", .15, .1); },
  tick(){ beep(900, .03, "square", 0, .04); },
  start(){ [392, 523, 659, 784].forEach((f, i) => beep(f, .1, "triangle", i * .09, .1)); },
  end(){ [784, 659, 784, 1047, 988, 1319].forEach((f, i) => beep(f, .16, "square", i * .12)); },
  page(){ beep(660, .05, "triangle", 0, .06); beep(880, .06, "triangle", .05, .05); },
  level(){ [523, 784, 1047, 1568].forEach((f, i) => beep(f, .14, "square", i * .1, .07)); }
};

/* ---------- haptics (Anna mobile shell, else the browser) ---------- */
export function haptic(anna, kind){
  const map = { good: { type: "notification", style: "success" }, bad: { type: "notification", style: "error" }, tap: { type: "selection" } };
  try {
    if (anna && anna.mobile && anna.mobile.haptics){ anna.mobile.haptics(map[kind] || map.tap).catch(() => {}); return; }
  } catch(e){}
  if (kind === "bad" && navigator.vibrate) try { navigator.vibrate(120); } catch(e){}
}

/* ---------- background stars + pixel bursts ---------- */
let cv, cx, stars = [], parts = [];
function size(){
  cv.width = innerWidth; cv.height = innerHeight; stars = [];
  for (let i = 0; i < 70; i++) stars.push({ x: Math.random() * cv.width, y: Math.random() * cv.height, s: (Math.random() * 3 | 0) + 2, v: Math.random() * .4 + .1, c: ["#4de1ff", "#ff4f8b", "#ffd23f", "#fff3d6"][i % 4] });
}
function loop(){
  cx.clearRect(0, 0, cv.width, cv.height);
  stars.forEach(s => {
    if (!RM && !document.hidden){ s.y += s.v; if (s.y > cv.height){ s.y = -4; s.x = Math.random() * cv.width; } }
    cx.globalAlpha = .55; cx.fillStyle = s.c; cx.fillRect(s.x | 0, s.y | 0, s.s, s.s);
  });
  cx.globalAlpha = 1;
  parts = parts.filter(p => { p.x += p.vx; p.y += p.vy; p.vy += .4; p.l--; cx.fillStyle = p.c; cx.fillRect(p.x | 0, p.y | 0, p.s, p.s); return p.l > 0; });
  requestAnimationFrame(loop);
}
export function initFX(canvas){
  cv = canvas; cx = cv.getContext("2d");
  addEventListener("resize", size); size(); loop();
}
export function burst(x, y, col, n){
  if (RM) return;
  for (let i = 0; i < (n || 24); i++) parts.push({ x, y, vx: (Math.random() - .5) * 8, vy: Math.random() * -8 - 1, l: 40 + Math.random() * 20, c: col || ["#ffd23f", "#5bef8c", "#4de1ff", "#ff4f8b"][i % 4], s: 6 });
}
