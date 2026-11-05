import type { SkyConditions } from "./skyConditions";
import { mixColor, skyPalette, type SkyPalette } from "./skyPalette";

/**
 * A live sky as SVG markup for a 96-unit-tall band, laid out the way the Night
 * sky artwork is: drawn at the header's height and continued sideways for as
 * wide as the sidebar gets, never stretched to fit. The sky, glow and stars
 * span the band; weather is composed on a 640-unit tile that repeats.
 *
 * Ids carry the `__ID__` placeholder so each mounted copy can make its own.
 */

const SKY_TILE = 640;
const HEIGHT = 96;
const REPEATS = Math.ceil(8192 / SKY_TILE);

/** Seeded, so a sky redraws identically until its conditions change. */
function random(seed: number) {
  let state = (seed * 2654435761) >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const n = (value: number) => (Math.round(value * 10) / 10).toString();
const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
const smooth = (edge0: number, edge1: number, value: number) => {
  const t = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
};

/** Where a body at this bearing and height sits in the band. Morning is right. */
const bodyX = (azimuth: number) => 212 + 50 * Math.sin((azimuth * Math.PI) / 180);
const bodyY = (altitude: number, rate: number) => Math.max(14, HEIGHT - altitude * rate);

/** Night sky's star field, unchanged, so a clear night keeps its stars. */
const STARS: ReadonlyArray<readonly [number, number, number, number]> = [
  [14, 10, 0.6, 0.85],
  [38, 22, 0.4, 0.55],
  [58, 8, 0.5, 0.7],
  [84, 16, 0.4, 0.5],
  [104, 7, 0.6, 0.8],
  [126, 20, 0.4, 0.55],
  [148, 11, 0.5, 0.7],
  [170, 24, 0.4, 0.5],
  [192, 9, 0.6, 0.8],
  [214, 18, 0.4, 0.55],
  [236, 8, 0.5, 0.7],
  [258, 20, 0.45, 0.6],
  [278, 11, 0.55, 0.75],
  [26, 34, 0.4, 0.45],
  [118, 34, 0.4, 0.45],
  [202, 32, 0.4, 0.5],
  [268, 34, 0.4, 0.45],
];
const SPARKLES: ReadonlyArray<readonly [number, number]> = [
  [70, 28],
  [160, 36],
  [246, 26],
];

/** The Night sky artwork's own two cloud banks, resting on the bottom edge. */
const CLOUD_LEFT =
  "M-12 88C-12 74 0 63 14 63C18 50 30 41 44 41C58 41 70 49 74 62C79 57 86 54 94 54C110 54 123 66 124 82C132 83 138 88 141 96H-12V88Z";
const CLOUD_RIGHT =
  "M150 96C151 84 161 75 173 75C176 64 186 57 198 57C210 57 220 64 223 75C231 75 238 80 241 87C250 87 257 91 260 96H150Z";

/** [shape, x offset, y offset, scale, opacity] */
type Bank = readonly [string, number, number, number, number];

/**
 * How many of those banks the sky shows, and where. A few percent of cover is
 * one bank; the Night sky's own pair is a partly cloudy sky; beyond that more
 * of the same banks stack in behind, until an overcast sky is a deck of them.
 * The seed nudges each bank's place and size so the hours differ, without
 * ever changing the shapes themselves.
 */
function cloudBanks(rand: () => number, conditions: SkyConditions): Bank[] {
  const cover = Math.max(conditions.low, conditions.mid * 0.9, conditions.high * 0.35);
  if (cover < 0.06) return [];
  const jitter = (range: number) => (rand() - 0.5) * range;
  const size = (base: number) => base * (0.9 + rand() * 0.25);
  if (cover < 0.22)
    return rand() < 0.5
      ? [[CLOUD_LEFT, 20 + jitter(60), 0, size(0.75), 0.9]]
      : [[CLOUD_RIGHT, -20 + jitter(80), 0, size(0.85), 0.85]];
  const pair = (dx: number): Bank[] => [
    [CLOUD_LEFT, dx + jitter(36), 0, size(1), 1],
    [CLOUD_RIGHT, dx + jitter(50), 0, size(1), 0.8],
  ];
  const banks: Bank[] = [];
  if (cover >= 0.5) {
    // A row behind, higher and fainter, the way the rain skies used to stack.
    const back = smooth(0.5, 0.8, cover);
    banks.push(
      [CLOUD_LEFT, 104 + jitter(40), -24, size(0.95), 0.9 * back],
      [CLOUD_RIGHT, -108 + jitter(40), -18, size(0.95), 0.85 * back],
      [CLOUD_LEFT, 424 + jitter(40), -22, size(0.95), 0.85 * back],
    );
  }
  if (cover >= 0.8) {
    const deck = smooth(0.8, 1, cover);
    banks.push(
      [CLOUD_LEFT, 58 + jitter(30), -2, size(1), 0.9 * deck],
      [CLOUD_RIGHT, 300 + jitter(40), -30, size(1), 0.8 * deck],
      [CLOUD_LEFT, 520 + jitter(30), -6, size(1), 0.9 * deck],
    );
  }
  banks.push(...pair(0));
  // A partly cloudy sky keeps the Night sky's open right side; a busier one
  // carries on across a wide sidebar.
  if (cover >= 0.5) banks.push(...pair(320));
  return banks;
}

/** Each bank blurred on its own, as the Night sky draws them. */
function banksMarkup(banks: readonly Bank[]) {
  return banks
    .map(
      ([shape, x, y, scale, opacity]) =>
        `<g filter="url(#__ID__soft)"><path d="${shape}" fill="url(#__ID__cloud)" fill-opacity="${n(opacity)}" transform="translate(${n(x)} ${n(HEIGHT + y - HEIGHT * scale)}) scale(${n(scale)})"/></g>`,
    )
    .join("");
}

function precipitation(rand: () => number, conditions: SkyConditions, palette: SkyPalette) {
  const { precipitation: kind, intensity } = conditions;
  if (kind === "none") return "";
  const slant = -(0.22 + Math.min(conditions.wind, 60) / 70);
  const drops: string[] = [];
  const rain = (count: number, length: number, width: number, fade: number) => {
    for (let index = 0; index < count; index++) {
      const x = rand() * (SKY_TILE + 20) - 10;
      const y = 26 + rand() * 72;
      const l = length * (0.7 + rand() * 0.6);
      drops.push(
        `<path d="M${n(x)} ${n(y)}l${n(slant * l)} ${n(l)}" stroke-width="${width}" opacity="${n(fade * (0.6 + rand() * 0.5))}"/>`,
      );
    }
  };
  const snow = (count: number) => {
    for (let index = 0; index < count; index++)
      drops.push(
        `<circle cx="${n(rand() * SKY_TILE)}" cy="${n(18 + rand() * 80)}" r="${n(0.45 + rand() * 0.9)}" opacity="${n(0.45 + rand() * 0.45)}"/>`,
      );
  };
  if (kind === "rain") rain(Math.round(36 + intensity * 110), 4.5 + intensity * 6, 0.65, 0.5);
  if (kind === "drizzle") rain(Math.round(70 + intensity * 70), 2.2, 0.45, 0.4);
  if (kind === "sleet") {
    rain(Math.round(30 + intensity * 50), 3.5, 0.55, 0.45);
    snow(Math.round(20 + intensity * 40));
  }
  if (kind === "snow") snow(Math.round(40 + intensity * 130));
  const tint = palette.precipitation;
  let shafts = "";
  if (kind === "rain" && intensity > 0.4)
    shafts = `<g filter="url(#__ID__haze)" fill="${palette.cloudB}" opacity="${n(intensity * 0.3)}">${Array.from(
      { length: 3 },
      () => {
        const x = rand() * SKY_TILE;
        return `<path d="M${n(x)} 60h${n(40 + rand() * 40)}l${n(slant * 36)} 40h-${n(40 + rand() * 40)}z"/>`;
      },
    ).join("")}</g>`;
  return `${shafts}<g stroke="${tint}" fill="${tint}" stroke-linecap="round">${drops.join("")}</g>`;
}

function fogBanks(rand: () => number, conditions: SkyConditions, palette: SkyPalette) {
  if (conditions.fog < 0.08) return "";
  const banks = Array.from({ length: 5 }, () => {
    return `<ellipse cx="${n(rand() * SKY_TILE)}" cy="${n(40 + rand() * 54)}" rx="${n(170 + rand() * 110)}" ry="${n(8 + rand() * 8)}"/>`;
  }).join("");
  return `<g filter="url(#__ID__haze)" fill="${palette.haze}" opacity="${n(Math.min(1, conditions.fog * 0.9))}">${banks}</g>`;
}

export const noise = (seed: number) => {
  const value = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
  return value - Math.floor(value);
};

/** A lightning channel: a wandering filament walked down from the cloud. */
export function filament(seed: number, x: number, top: number, bottom: number) {
  const points: Array<readonly [number, number]> = [[x, top]];
  let cursor = [x, top] as const;
  for (let step = 0; cursor[1] < bottom; step++) {
    cursor = [
      cursor[0] + (noise(seed + step + 50) - 0.5) * 11,
      cursor[1] + 4 + noise(seed + step) * 7,
    ];
    points.push(cursor);
  }
  return points;
}

export const trace = (points: ReadonlyArray<readonly [number, number]>) =>
  points.map(([x, y], index) => `${index ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join("");

/**
 * A flash lighting the cloud from inside, and on some hours a thin channel
 * reaching down out of it. Never a bolt glyph: the channel wanders and forks
 * the way a real one does, and half the time there is only the glow.
 */
function lightning(seed: number, x: number) {
  const glow = `<ellipse cx="${n(x)}" cy="44" rx="110" ry="70" fill="url(#__ID__flash)"/>`;
  if (noise(seed * 3.1) < 0.5) return glow;
  const main = filament(seed, x, 22, 92);
  const fork = main[Math.floor(main.length / 2)]!;
  const branch = filament(seed + 17, fork[0], fork[1], fork[1] + 20);
  return `${glow}
<g fill="none" stroke="#eef2ff" stroke-linecap="round" stroke-linejoin="round">
 <g filter="url(#__ID__puff)" opacity=".7"><path d="${trace(main)}" stroke-width="3.2"/><path d="${trace(branch)}" stroke-width="2"/></g>
 <path d="${trace(main)}" stroke-width=".9" opacity="1"/><path d="${trace(branch)}" stroke-width=".55" opacity=".7"/>
</g>`;
}

/** The lit part of the moon for its phase, bounded by the terminator. */
function moonPath(cx: number, cy: number, r: number, fraction: number, waxing: boolean) {
  const terminator = r * Math.abs(2 * fraction - 1);
  const limb = waxing ? 1 : 0;
  const gibbous = fraction > 0.5;
  const sweep = waxing === gibbous ? 1 : 0;
  return `M${n(cx)} ${n(cy - r)}A${n(r)} ${n(r)} 0 0 ${limb} ${n(cx)} ${n(cy + r)}A${n(terminator)} ${n(r)} 0 0 ${sweep} ${n(cx)} ${n(cy - r)}Z`;
}

export function skySceneMarkup(conditions: SkyConditions): string {
  const palette = skyPalette(conditions);
  const rand = random(conditions.seed);
  const cover = Math.max(conditions.low, conditions.mid * 0.9);

  const sunX = bodyX(conditions.sunAzimuth);
  const sunY = bodyY(conditions.sun, 2.6);
  // Past civil twilight the glow leaves the sun. With the moon up it gathers
  // round the moon, brighter the fuller it is, and lingers there even behind
  // cloud; on a moonless night it settles where the Night sky keeps it.
  const moon = conditions.moon;
  const moonUp = moon !== null && moon.altitude > 0 && moon.fraction > 0.04;
  const moonX = moon ? bodyX(moon.azimuth) : 0;
  const moonY = moon ? bodyY(moon.altitude, 2.2) : 0;
  const nightX = moonUp ? moonX : 216;
  const nightY = moonUp ? moonY : 18;
  const settle = smooth(-4, -12, conditions.sun);
  const glowX = sunX + (nightX - sunX) * settle;
  const glowY =
    (conditions.sun < 0 ? HEIGHT - conditions.sun * 2.6 : sunY) * (1 - settle) + nightY * settle;
  const glowStrength =
    palette.glowStrength * (1 + ((moonUp ? 0.55 + 0.6 * moon.fraction : 1) - 1) * settle);
  const low = smooth(-10, -2, conditions.sun) * (1 - smooth(4, 16, conditions.sun));
  const glowWidth = 120 + 60 * low;
  const glowHeight = 84 - 16 * low;

  const opacity = palette.cloudOpacity / 0.56;
  const defs = `<defs>
<linearGradient id="__ID__sky" x1="24" y1="0" x2="264" y2="96" gradientUnits="userSpaceOnUse" spreadMethod="reflect"><stop stop-color="${palette.skyA}"/><stop offset=".5" stop-color="${palette.skyB}"/><stop offset="1" stop-color="${palette.skyC}"/></linearGradient>
<linearGradient id="__ID__horizon" x1="0" y1="18" x2="0" y2="96" gradientUnits="userSpaceOnUse"><stop stop-color="${palette.horizon}" stop-opacity="0"/><stop offset="1" stop-color="${palette.horizon}" stop-opacity="${n(palette.horizonStrength)}"/></linearGradient>
<radialGradient id="__ID__glow" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(${n(glowX)} ${n(glowY)}) rotate(137) scale(${n(glowWidth)} ${n(glowHeight)})"><stop stop-color="${palette.glow}" stop-opacity="${n(glowStrength)}"/><stop offset=".5" stop-color="${palette.glowEdge}" stop-opacity="${n(glowStrength * 0.4)}"/><stop offset="1" stop-color="${palette.skyA}" stop-opacity="0"/></radialGradient>
<linearGradient id="__ID__cloud" x1="0" y1="60" x2="288" y2="96" gradientUnits="userSpaceOnUse" spreadMethod="reflect"><stop stop-color="${palette.cloudA}" stop-opacity="${n(Math.min(1, 0.5 * opacity))}"/><stop offset=".52" stop-color="${palette.cloudB}" stop-opacity="${n(Math.min(1, 0.62 * opacity))}"/><stop offset="1" stop-color="${palette.cloudC}" stop-opacity="${n(Math.min(1, 0.5 * opacity))}"/></linearGradient>
<linearGradient id="__ID__fog" x1="0" y1="0" x2="0" y2="96" gradientUnits="userSpaceOnUse"><stop stop-color="${palette.haze}" stop-opacity=".55"/><stop offset="1" stop-color="${palette.haze}"/></linearGradient>
<radialGradient id="__ID__flash" cx=".5" cy=".5" r=".5"><stop stop-color="#dfe6ff" stop-opacity=".62"/><stop offset="1" stop-color="#e4eaff" stop-opacity="0"/></radialGradient>
<radialGradient id="__ID__bloom" cx=".5" cy=".5" r=".5"><stop stop-color="${mixColor(palette.glow, "#ffffff", 0.5)}" stop-opacity=".55"/><stop offset="1" stop-color="${palette.glow}" stop-opacity="0"/></radialGradient>
<pattern id="__ID__stars" width="288" height="96" patternUnits="userSpaceOnUse"><g fill="#e4e9ff">${STARS.map(([x, y, r, o]) => `<circle cx="${x}" cy="${y}" r="${r}" fill-opacity="${o}"/>`).join("")}</g><g stroke="#d3dcff" stroke-linecap="round" stroke-opacity=".7" stroke-width=".6">${SPARKLES.map(([x, y]) => `<path d="M${x - 1.5} ${y}H${x + 1.5}M${x} ${y - 1.5}V${y + 1.5}"/>`).join("")}</g></pattern>
<filter id="__ID__soft" x="-60" y="-40" width="${SKY_TILE + 120}" height="176" filterUnits="userSpaceOnUse"><feGaussianBlur stdDeviation="4"/></filter>
<filter id="__ID__puff" x="-60" y="-40" width="${SKY_TILE + 120}" height="176" filterUnits="userSpaceOnUse"><feGaussianBlur stdDeviation="2.2"/></filter>
<filter id="__ID__haze" x="-60" y="-40" width="${SKY_TILE + 120}" height="176" filterUnits="userSpaceOnUse"><feGaussianBlur stdDeviation="8"/></filter>
</defs>`;

  let bodies = "";
  const disc = (1 - cover * 0.9) * (1 - conditions.fog * 0.8);
  if (conditions.sun > -1.5 && conditions.sun < 22 && disc > 0.12) {
    const r = 5.5 + 1.5 * (1 - smooth(0, 10, conditions.sun));
    bodies += `<circle cx="${n(sunX)}" cy="${n(sunY)}" r="${n(r * 3.2)}" fill="url(#__ID__bloom)" opacity="${n(disc)}"/><circle cx="${n(sunX)}" cy="${n(sunY)}" r="${n(r)}" fill="${mixColor(palette.glow, "#fffaf0", 0.65)}" opacity="${n(disc * 0.95)}"/>`;
  }
  const moonVisible = (1 - cover * 0.95) * (1 - conditions.fog) * smooth(2, -4, conditions.sun);
  if (moonUp && moonVisible > 0.1) {
    const mx = moonX;
    const my = moonY;
    bodies += `<circle cx="${n(mx)}" cy="${n(my)}" r="15" fill="url(#__ID__bloom)" opacity="${n(moonVisible * 0.5 * moon.fraction)}"/><circle cx="${n(mx)}" cy="${n(my)}" r="5" fill="#e4e9ff" opacity="${n(moonVisible * 0.12)}"/><path d="${moonPath(mx, my, 5, moon.fraction, moon.waxing)}" fill="#eef1ff" opacity="${n(moonVisible * 0.92)}"/>`;
  }

  const tile =
    banksMarkup(cloudBanks(rand, conditions)) +
    precipitation(rand, conditions, palette) +
    fogBanks(rand, conditions, palette);
  const copies = tile
    ? `<g id="__ID__tile">${tile}</g>${Array.from({ length: REPEATS - 1 }, (_, index) => `<use href="#__ID__tile" x="${(index + 1) * SKY_TILE}"/>`).join("")}`
    : "";
  const flash = conditions.thunder
    ? lightning(conditions.seed, 150 + noise(conditions.seed) * 110)
    : "";
  const veil =
    conditions.fog > 0.05
      ? `<rect width="100%" height="${HEIGHT}" fill="url(#__ID__fog)" opacity="${n(Math.min(0.92, conditions.fog * 0.85))}"/>`
      : "";

  return `${defs}
<rect width="100%" height="${HEIGHT}" fill="url(#__ID__sky)"/>
<rect width="100%" height="${HEIGHT}" fill="url(#__ID__horizon)"/>
<rect width="100%" height="${HEIGHT}" fill="url(#__ID__glow)"/>
${palette.stars > 0.02 ? `<rect width="100%" height="${HEIGHT}" fill="url(#__ID__stars)" opacity="${n(palette.stars)}"/>` : ""}
${bodies}${copies}${flash}${veil}`;
}
