/* Pixel Trivia — original pixel-art sprites rendered as inline SVG (CSP-safe: no images, no styles).
   Each sprite is rows of characters; '.' is transparent and every other character maps to a colour. */

const OUTLINE = "#0b0620";

const BIT = {
  rows: [
    "................",
    "..kk........kk..",
    "..kbk......kbk..",
    "..kbbkkkkkkbbk..",
    ".kbbbbbbbbbbbbk.",
    ".kbwwwbbbbwwwbk.",
    ".kwwwpwbbwpwwwk.",
    ".kwwppwbbwppwwk.",
    ".kbwwwbyybwwwbk.",
    ".kbbbbbyybbbbbk.",
    ".kbbccccccccbbk.",
    ".kbcccbccbcccbk.",
    ".kbccbccccbccbk.",
    "..kbcccccccbbk..",
    "...kkkyykkyykk..",
    "................"
  ],
  pal: { k: OUTLINE, b: "#7a5cff", c: "#c3b5ff", w: "#fff3d6", p: "#1c1240", y: "#ffd23f" }
};

/* Bit with eyes closed (used for the blink). */
const BIT_BLINK = {
  rows: BIT.rows.map((r, i) => i === 6 ? ".kbbbbbbbbbbbbk." : i === 7 ? ".kbkkkbbbbkkkbk." : r),
  pal: BIT.pal
};

const AV = (rows, o, extra = {}) => ({ rows, pal: { k: OUTLINE, o, w: "#fff3d6", p: "#1c1240", ...extra } });
export const AVATARS = [
  { id: "cat", n: "Cat", s: AV(["kk......kk", "kok....kok", "kookkkkook", "kooooooook", "kowpoowpok", "kooooooook", "koooppoook", "kooooooook", ".kooooook.", "..kkkkkk.."], "#ff9f43") },
  { id: "frog", n: "Frog", s: AV([".kkk..kkk.", "kwwpkkwwpk", "kwwwkkwwwk", "kooooooook", "kooooooook", "koppppppok", "kooooooook", "kooooooook", ".kooooook.", "..kkkkkk.."], "#5bef8c") },
  { id: "robot", n: "Robot", s: AV(["....kk....", "....kk....", "kkkkkkkkkk", "kooooooook", "kowwoowwok", "kowpoowpok", "kooooooook", "kopkpkpkok", "kooooooook", "kkkkkkkkkk"], "#4de1ff") },
  { id: "ghost", n: "Ghost", s: AV(["..kkkkkk..", ".kooooook.", "kooooooook", "kowpoowpok", "kooooooook", "koooppoook", "kooooooook", "kooooooook", "kooooooook", "k.kk..kk.k"], "#e8e2ff") },
  { id: "alien", n: "Alien", s: AV(["k........k", ".k......k.", "..kkkkkk..", ".kooooook.", "kooooooook", "kpppoopppk", "koppooppok", ".kooooook.", "..kooook..", "...kkkk..."], "#b6f36b") },
  { id: "slime", n: "Slime", s: AV(["....kk....", "...kook...", "..kooook..", ".kooooook.", "kowpoowpok", "kooooooook", "kopoooopok", "kooppppook", "kooooooook", "kkkkkkkkkk"], "#ff4f8b") },
  { id: "knight", n: "Knight", s: AV(["...kkkk...", "..kooook..", ".kooooook.", "kooooooook", "kppppppppk", "kpwwppwwpk", "kppppppppk", "kooooooook", "kopopopopk", "kkkkkkkkkk"], "#ffd23f") },
  { id: "bunny", n: "Bunny", s: AV([".kk....kk.", ".kok..kok.", ".kok..kok.", ".kookkook.", "kooooooook", "kowpoowpok", "kooooooook", "koooppoook", ".kooooook.", "..kkkkkk.."], "#c8a8ff") }
];
export const AVATAR = Object.fromEntries(AVATARS.map(a => [a.id, a]));

/* Render a sprite as SVG. Horizontal runs of one colour become one rect. */
function svg(sprite, cls, label){
  const h = sprite.rows.length, w = sprite.rows[0].length;
  let rects = "";
  sprite.rows.forEach((row, y) => {
    let x = 0;
    while (x < w){
      const c = row[x];
      let run = 1;
      while (x + run < w && row[x + run] === c) run++;
      if (c !== "." && sprite.pal[c]) rects += `<rect x="${x}" y="${y}" width="${run}" height="1" fill="${sprite.pal[c]}"/>`;
      x += run;
    }
  });
  const a11y = label ? `role="img" aria-label="${label}"` : `aria-hidden="true"`;
  return `<svg class="${cls}" viewBox="0 0 ${w} ${h}" shape-rendering="crispEdges" ${a11y}>${rects}</svg>`;
}

export const bitSVG = (cls = "bit") => `<span class="bitwrap ${cls}">${svg(BIT, "bit-open", "Bit the owl")}${svg(BIT_BLINK, "bit-shut")}</span>`;
export const avatarSVG = (id, cls = "av") => svg((AVATAR[id] || AVATARS[0]).s, cls, (AVATAR[id] || AVATARS[0]).n);
