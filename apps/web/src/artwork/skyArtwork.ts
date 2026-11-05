import { skyWeatherOf, type SkyConditions, type SkyPhase, type SkyWeather } from "./skyConditions";
import { skyPalette } from "./skyPalette";
import { filament, noise, trace } from "./skyScene";

export type { SkyConditions, SkyPhase, SkyWeather } from "./skyConditions";
const SKY_PHASES: readonly SkyPhase[] = ["dawn", "day", "dusk", "night"];
const SKY_WEATHER: readonly SkyWeather[] = ["clear", "cloudy", "rain", "snow", "fog", "storm"];
export const isLocalSky = (selection: string) =>
  selection === "local-day-night" || selection === "local-weather";
const title = (value: string) => value[0]!.toUpperCase() + value.slice(1);
export const SKY_OPTIONS = SKY_PHASES.flatMap((phase) =>
  SKY_WEATHER.map((weather) => ({
    value: `sky-${phase}-${weather}`,
    label: `${title(phase)} · ${title(weather)}`,
    phase,
    weather,
  })),
);

/**
 * App icons are the shipped MT tile repainted, never a redrawn lookalike: its
 * artwork, gloss and mark stay exactly as they ship and only the colour moves.
 * Each tone of the tile is mapped onto the scene's own palette, so the icon
 * carries the same colours as that sky rather than an arbitrary hue shift.
 *
 * Six evenly spaced stops from the darkest sky to white; white keeps the mark
 * and the rim gloss at full value.
 */
const mix = (from: string, to: string, amount: number) =>
  `#${[1, 3, 5]
    .map((at) => {
      const a = Number.parseInt(from.slice(at, at + 2), 16);
      const b = Number.parseInt(to.slice(at, at + 2), 16);
      return Math.round(a + (b - a) * amount)
        .toString(16)
        .padStart(2, "0");
    })
    .join("")}`;

/**
 * How much cloud the scene shows. The tile's cloud banks cannot be removed, so
 * coverage is carried by their value: a cloudy sky lifts them toward white, a
 * clear one lets them sink back into the sky.
 */
const cloudLift: Record<SkyWeather, number> = {
  clear: -0.08,
  cloudy: 0.26,
  rain: -0.05,
  snow: 0.3,
  fog: 0.12,
  storm: -0.08,
};

/**
 * Where each palette colour sits on the tile's tonal range. The sky colours are
 * packed low and the cloud colours hold the middle, because the tile's cloud
 * banks sit around half luminance: spacing the stops evenly instead drags a
 * dark sky colour across them and the banks go muddy.
 */
const RAMP_POSITIONS = [0, 0.1, 0.26, 0.5, 0.74, 1] as const;

/** The least each stop may sit below the next, from darkest to brightest. */
const CROWDING = [0.02, 0.02, 0.18, 0.1] as const;

/** The darkest the tile's sky may go before it reads as a black square. */
const ICON_FLOOR = 0.035;

/** The sky's brightest tone; the mark's outline is lifted above it. */
const SKY_CEILING = 0.84;

/**
 * The mark and its outline are neutral and never take the sky's colour, and
 * they always sit above it: a bright sky otherwise lifts the tile's clouds past
 * the outline, the outline stops reading as the mark's lighter edge, and the
 * mark comes out drawn in dashes.
 */
export const markTone = (level: number) =>
  Math.min(1, SKY_CEILING + 0.05 + Math.max(0, (level - 0.5) / 0.5) * (1 - SKY_CEILING - 0.05));

const luminance = (color: string) =>
  (Number.parseInt(color.slice(1, 3), 16) * 0.2126 +
    Number.parseInt(color.slice(3, 5), 16) * 0.7152 +
    Number.parseInt(color.slice(5, 7), 16) * 0.0722) /
  255;

/** A dark night with nothing falling is the shipped tile's own sky. */
const isShippedNight = (conditions: SkyConditions) => {
  const weather = skyWeatherOf(conditions);
  return conditions.sun <= -12 && (weather === "clear" || weather === "cloudy");
};

/**
 * The sky an icon is drawn for, rounded far coarser than the sidebar's: the
 * repaint walks a million pixels, so the Dock tile moves on in steps of a few
 * degrees of sun rather than every minute.
 */
export function skyIconConditions(conditions: SkyConditions): SkyConditions {
  const step = Math.abs(conditions.sun) < 16 ? 2 : 10;
  const round = (value: number, by: number) => Math.round(value / by) * by;
  return {
    ...conditions,
    sun: round(conditions.sun, step),
    sunAzimuth: conditions.sunAzimuth < 180 ? 90 : 270,
    moon: null,
    low: round(conditions.low, 0.25),
    mid: round(conditions.mid, 0.25),
    high: round(conditions.high, 0.25),
    intensity: round(conditions.intensity, 0.5),
    fog: round(conditions.fog, 0.5),
    wind: 10,
    seed: 0,
  };
}

export const skyIconKey = (conditions: SkyConditions) => {
  const icon = skyIconConditions(conditions);
  return [
    icon.sun,
    icon.sunAzimuth,
    icon.low,
    icon.mid,
    icon.high,
    icon.precipitation,
    icon.intensity,
    icon.thunder,
    icon.fog,
  ].join("|");
};

function skyIconRamp(conditions: SkyConditions): readonly string[] | null {
  // The shipped tile already is a cloudy night, so that sky ships untouched.
  if (isShippedNight(conditions)) return null;
  const weather = skyWeatherOf(conditions);
  const palette = skyPalette(conditions);
  const [rawBottom, mid, top, cloudA, cloudB] = [
    palette.skyA,
    palette.skyB,
    palette.skyC,
    palette.cloudA,
    palette.cloudB,
  ];
  // The mark's drop shadow is only a little darker than the tile's night sky.
  // A bright scene would drop it all the way to that scene's darkest colour,
  // which reads as a hole punched round the mark, so the floor rises with the
  // sky: no change at night, most of the way to the mid tone at midday.
  const floor = Math.min(0.3, Math.max(0, (luminance(mid) - 0.12) * 1.5));
  const bottom = mix(rawBottom, mid, floor);
  // Night keeps one cloud treatment across its weather so the whole row reads
  // as the same sky the default icon shows.
  const lift = conditions.sun <= -12 ? cloudLift.cloudy : cloudLift[weather];
  // Sinking clouds means pulling them toward the body of the sky, never toward
  // its lit horizon, which would only make them brighter.
  const toward = lift > 0 ? "#ffffff" : mid;
  const amount = Math.abs(lift);
  // Ordered by their own brightness, never by their role in the sky. A dusk or
  // midday palette can have a lit horizon brighter than its clouds, and out of
  // order those stops invert the tile's own shading: a shadow lands lighter
  // than what it falls on, which is what makes the mark look cut out.
  const stops = [bottom, mid, top, mix(cloudB, toward, amount), mix(cloudA, toward, amount)];
  // Ordered by their own brightness, never by their role in the sky. A dusk or
  // midday palette can have a lit horizon brighter than its clouds, and out of
  // order those stops invert the tile's shading: a shadow lands lighter than
  // what it falls on, which is what makes the mark look cut out.
  const ordered = stops.sort((a, b) => luminance(a) - luminance(b));
  const levels = ordered.map(luminance);
  // Then pulled apart where they crowd. The tile's cloud layers live between
  // the third and fourth stops, so a palette whose top tones sit within a hair
  // of one another — midday's were 0.01 apart — paints every layer the same
  // colour. The lower stop gives way, since the brightest has to stay near
  // white for cloud to read as cloud.
  for (let index = levels.length - 2; index >= 0; index--)
    levels[index] = Math.min(levels[index]!, levels[index + 1]! - CROWDING[index]!);
  // A dark sky, a rainy twilight say, has no room below to spread into, and
  // pushing down leaves the tile black. There the upper stops give way instead.
  levels[0] = Math.max(levels[0]!, ICON_FLOOR);
  for (let index = 0; index < levels.length - 1; index++)
    levels[index + 1] = Math.max(levels[index + 1]!, levels[index]! + CROWDING[index]!);
  return [
    ...ordered.map((color, index) => {
      const shade = luminance(color);
      const target = Math.max(0.02, levels[index]!);
      return shade <= 0 ? color : mix("#000000", color, Math.min(1, target / shade));
    }),
    "#ffffff",
  ];
}

/** The ramp colour for a 0..1 tone, honouring where each stop sits. */
function sampleSkyRamp(ramp: readonly string[], level: number): string {
  const last = ramp.length - 1;
  let index = 0;
  while (index < last - 1 && level > RAMP_POSITIONS[index + 1]!) index++;
  const from = RAMP_POSITIONS[index]!;
  const span = RAMP_POSITIONS[index + 1]! - from;
  return mix(ramp[index]!, ramp[index + 1]!, Math.min(1, Math.max(0, (level - from) / span)));
}

/**
 * The tone the tile's every brightness becomes, as 256 colours.
 *
 * Straight from the scene's palette: its sky colours carry the tile's sky and
 * its cloud colours carry the clouds, so a daytime sky stays a deep blue under
 * near-white cloud. The mark rides above all of it — see `markTone` — which is
 * what lets the sky use its full range without overtaking the mark's outline.
 */
export function skyIconLookup(conditions: SkyConditions): readonly string[] | null {
  const ramp = skyIconRamp(conditions);
  if (ramp === null) return null;
  return Array.from({ length: 256 }, (_, step) => sampleSkyRamp(ramp, step / 255));
}

// The shipped tile is a squircle inset in its 1024 canvas; weather stays inside it.
const ICON_SHAPE = { x: 104, y: 104, size: 816, radius: 190 };

const iconStrike = trace(filament(11, 620, 150, 760));

/**
 * Where the tile's stars and sparkles sit. Daylight and overcast skies have
 * none, so those spots take the tone of the sky around them before the repaint
 * and vanish into it; a clear or lightly clouded sky keeps them.
 */
export const TILE_STARS: ReadonlyArray<readonly [number, number]> = [
  [159, 547],
  [203, 207],
  [295, 237],
  [446, 181],
  [817, 471],
  [849, 364],
  [856, 664],
];

export const skyHidesStars = (conditions: SkyConditions) => skyPalette(conditions).stars < 0.3;

/** Transparent 1024 overlay: what a repaint alone cannot say. */
function skyIconOverlaySvg(conditions: SkyConditions): string {
  const weather = skyWeatherOf(conditions);
  const tint = skyPalette(conditions).cloudA;
  let body = "";
  if (weather === "rain" || weather === "snow" || weather === "storm") {
    const count = weather === "storm" ? 46 : weather === "rain" ? 40 : 34;
    body += Array.from({ length: count }, (_, index) => {
      const x = (ICON_SHAPE.x + noise(index + 5) * ICON_SHAPE.size).toFixed(0);
      const y = (ICON_SHAPE.y + noise(index + 61) * ICON_SHAPE.size).toFixed(0);
      const fade = (0.3 + noise(index + 13) * 0.35).toFixed(2);
      if (weather === "snow")
        return `<circle cx="${x}" cy="${y}" r="${(5 + noise(index + 29) * 7).toFixed(1)}" fill="#f2f6ff" opacity="${fade}"/>`;
      const storm = weather === "storm";
      return `<path d="M${x} ${y}l${storm ? -22 : -14} ${(storm ? 58 : 42) + noise(index + 37) * 26}" stroke="${tint}" stroke-width="${storm ? 6 : 5}" stroke-linecap="round" opacity="${fade}"/>`;
    }).join("");
  }
  // The flash sits behind the rain.
  if (weather === "storm")
    body =
      `<ellipse cx="620" cy="360" rx="330" ry="330" fill="url(#iconFlash)"/><g fill="none" stroke="#eaf0ff" stroke-linecap="round" stroke-linejoin="round"><g filter="url(#iconBlur)" opacity=".45"><path d="${iconStrike}" stroke-width="26"/></g><path d="${iconStrike}" stroke-width="7" opacity=".95"/></g>` +
      body;
  if (weather === "fog")
    body += `<g filter="url(#iconBlur)" fill="${tint}"><ellipse cx="380" cy="470" rx="520" ry="52" opacity=".4"/><ellipse cx="640" cy="640" rx="540" ry="58" opacity=".46"/><ellipse cx="420" cy="810" rx="520" ry="54" opacity=".42"/></g>`;
  if (body === "") return "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024" fill="none">
<defs>
 <clipPath id="iconShape"><rect x="${ICON_SHAPE.x}" y="${ICON_SHAPE.y}" width="${ICON_SHAPE.size}" height="${ICON_SHAPE.size}" rx="${ICON_SHAPE.radius}"/></clipPath>
 <radialGradient id="iconFlash" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(620 360) scale(330)"><stop stop-color="#e4eaff" stop-opacity=".3"/><stop offset="1" stop-color="#e4eaff" stop-opacity="0"/></radialGradient>
 <filter id="iconBlur" x="-10%" y="-10%" width="120%" height="120%"><feGaussianBlur stdDeviation="26"/></filter>
 <filter id="iconBlur2" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="4"/></filter>
</defs>
<g clip-path="url(#iconShape)">${body}</g>
</svg>`;
}

const overlayCache = new Map<string, string>();
export function skyIconOverlayImage(conditions: SkyConditions): string {
  const key = `${skyWeatherOf(conditions)}-${skyPalette(conditions).cloudA}`;
  let image = overlayCache.get(key);
  if (image === undefined) {
    const svg = skyIconOverlaySvg(conditions);
    image = svg === "" ? "" : `data:image/svg+xml,${encodeURIComponent(svg)}`;
    overlayCache.set(key, image);
  }
  return image;
}
