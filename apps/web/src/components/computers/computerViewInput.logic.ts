/**
 * Maps browser pointer/keyboard/wheel events onto ComputerViewInput payloads
 * for the remote machine. Coordinates entering these helpers are already in
 * remote screen space (see mapViewerPointToScreen in @t3tools/shared).
 */
import { COMPUTER_VIEW_MAX_WIDTH_LIMIT, type ComputerViewInput } from "@t3tools/contracts";

/** Pointer movement below this many remote-screen pixels stays a click. */
const COMPUTER_VIEW_DRAG_THRESHOLD_PX = 5;

const WHEEL_PIXELS_PER_SCROLL_LINE = 40;
const MAX_SCROLL_AMOUNT = 20;

/** DOM `KeyboardEvent.key` names to the desktop MCP's named-key vocabulary. */
const NAMED_KEYS: Readonly<Record<string, string>> = {
  Enter: "return",
  Tab: "tab",
  Escape: "escape",
  Backspace: "backspace",
  // "delete" means backspace on the macOS helper, so use the explicit name.
  Delete: "forwarddelete",
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
  Home: "home",
  End: "end",
  PageUp: "pageup",
  PageDown: "pagedown",
};

const FUNCTION_KEY = /^F([1-9]|1[0-2])$/;

interface KeyboardEventLike {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
}

function eventModifiers(
  event: KeyboardEventLike,
  options?: { readonly includeShift?: boolean },
): Array<"cmd" | "shift" | "alt" | "ctrl"> {
  const modifiers: Array<"cmd" | "shift" | "alt" | "ctrl"> = [];
  if (event.metaKey) modifiers.push("cmd");
  if (event.ctrlKey) modifiers.push("ctrl");
  if (event.altKey) modifiers.push("alt");
  if (event.shiftKey && options?.includeShift !== false) modifiers.push("shift");
  return modifiers;
}

/**
 * Keydown to remote input. Plain printable characters go through `type` so
 * the remote types the exact character (shift, layout, and symbols included);
 * chords and named keys go through `key`. Bare modifier presses map to null.
 */
export function mapKeyboardEventToComputerViewInput(
  event: KeyboardEventLike,
): ComputerViewInput | null {
  const named =
    NAMED_KEYS[event.key] ?? (FUNCTION_KEY.test(event.key) ? event.key.toLowerCase() : undefined);
  if (named !== undefined) {
    const modifiers = eventModifiers(event);
    return {
      type: "key",
      key: named,
      ...(modifiers.length === 0 ? {} : { modifiers }),
    };
  }
  const isPrintable = event.key.length === 1 || event.key === " ";
  if (!isPrintable) return null;
  if (event.metaKey || event.ctrlKey || event.altKey) {
    // Chords target the key itself; the character already encodes shift, so
    // it is only forwarded when it does not change the character (letters).
    const lowered = event.key.toLowerCase();
    const includeShift = lowered !== event.key.toUpperCase() || event.key === " ";
    return {
      type: "key",
      key: event.key === " " ? "space" : lowered,
      modifiers: eventModifiers(event, { includeShift }),
    };
  }
  return { type: "type", text: event.key };
}

/**
 * One wheel event to one scroll input on the dominant axis, or null for a
 * zero-delta event.
 */
export function mapWheelToComputerViewInput(input: {
  readonly deltaX: number;
  readonly deltaY: number;
  readonly x: number;
  readonly y: number;
}): ComputerViewInput | null {
  const dominantY = Math.abs(input.deltaY) >= Math.abs(input.deltaX);
  const delta = dominantY ? input.deltaY : input.deltaX;
  if (delta === 0) return null;
  const direction = dominantY ? (delta > 0 ? "down" : "up") : delta > 0 ? "right" : "left";
  const amount = Math.min(
    MAX_SCROLL_AMOUNT,
    Math.max(1, Math.round(Math.abs(delta) / WHEEL_PIXELS_PER_SCROLL_LINE)),
  );
  return { type: "scroll", x: input.x, y: input.y, direction, amount };
}

/**
 * A completed pointer gesture: a drag when the pointer moved past the
 * threshold, otherwise a click at the release point. Secondary-button
 * gestures always resolve to a right click (remote right-drag is not
 * supported by the input path).
 */
export function classifyPointerGesture(input: {
  readonly from: { readonly x: number; readonly y: number };
  readonly to: { readonly x: number; readonly y: number };
  readonly button: "left" | "right";
  readonly clickCount: number;
  readonly thresholdPx?: number;
}): ComputerViewInput {
  const threshold = input.thresholdPx ?? COMPUTER_VIEW_DRAG_THRESHOLD_PX;
  const movedPx = Math.hypot(input.to.x - input.from.x, input.to.y - input.from.y);
  if (input.button === "left" && movedPx > threshold) {
    return {
      type: "drag",
      fromX: input.from.x,
      fromY: input.from.y,
      toX: input.to.x,
      toY: input.to.y,
    };
  }
  const clickCount = Math.min(3, Math.max(1, input.clickCount));
  return {
    type: "click",
    x: input.to.x,
    y: input.to.y,
    ...(input.button === "right" ? { button: "right" as const } : {}),
    ...(clickCount === 1 ? {} : { clickCount }),
  };
}

/**
 * Capture width to ask the host for, given how large the viewer is drawing the
 * screen. Rounded to a step so a drag-resize does not restart the stream on
 * every pixel, and clamped so a huge monitor cannot ask the host to encode
 * more than the link can carry.
 */
export function resolveComputerViewCaptureWidth(input: {
  readonly renderedWidth: number;
  readonly devicePixelRatio: number;
  readonly step?: number;
  readonly min?: number;
  readonly max?: number;
}): number {
  const step = input.step ?? 160;
  const min = input.min ?? 960;
  const max = input.max ?? COMPUTER_VIEW_MAX_WIDTH_LIMIT;
  const ratio =
    Number.isFinite(input.devicePixelRatio) && input.devicePixelRatio > 0
      ? Math.min(input.devicePixelRatio, 2)
      : 1;
  const wanted = input.renderedWidth * ratio;
  if (!Number.isFinite(wanted) || wanted <= 0) return min;
  const stepped = Math.ceil(wanted / step) * step;
  return Math.min(max, Math.max(min, stepped));
}

/** Data URL for rendering a streamed frame in an <img>. */
export function computerViewFrameDataUrl(frame: {
  readonly mimeType: string;
  readonly data: string;
}): string {
  return `data:${frame.mimeType};base64,${frame.data}`;
}

type ComputerViewModifier = "cmd" | "shift" | "alt" | "ctrl" | "fn";
type RemoteOs = "darwin" | "linux" | "windows" | "unknown";

/**
 * Carries a shortcut across the Mac/PC divide: Cmd-C pressed on a Mac copies
 * on a Windows or Linux machine (Ctrl-C there), and Ctrl-C pressed on a PC
 * copies on a Mac (Cmd-C). Same-family pairs, and inputs without modifiers,
 * pass through untouched.
 */
export function mapShortcutModifiersForRemote(
  input: ComputerViewInput,
  context: { readonly localIsMac: boolean; readonly remoteOs: RemoteOs | null },
): ComputerViewInput {
  if (
    input.type !== "key" ||
    input.modifiers === undefined ||
    context.remoteOs === null ||
    context.remoteOs === "unknown"
  ) {
    return input;
  }
  const remoteIsMac = context.remoteOs === "darwin";
  if (context.localIsMac === remoteIsMac) return input;
  const [from, to]: [ComputerViewModifier, ComputerViewModifier] = context.localIsMac
    ? ["cmd", "ctrl"]
    : ["ctrl", "cmd"];
  if (!input.modifiers.includes(from)) return input;
  const modifiers: ComputerViewModifier[] = [];
  for (const modifier of input.modifiers) {
    const mapped = modifier === from ? to : modifier;
    if (!modifiers.includes(mapped)) modifiers.push(mapped);
  }
  return { ...input, modifiers };
}

export interface ComputerViewKeyPreset {
  readonly label: string;
  readonly description: string;
  readonly input: ComputerViewInput;
}

/**
 * One-click system shortcuts for the remote machine: the chords this computer
 * would otherwise keep for itself (app switching, Spotlight, Task Manager).
 * Ctrl-Alt-Del is absent on purpose: Windows only accepts it from the
 * hardware keyboard, so no remote input can send it.
 */
export function computerViewKeyPresets(
  remoteOs: RemoteOs | null,
): ReadonlyArray<ComputerViewKeyPreset> {
  if (remoteOs === "darwin") {
    return [
      {
        label: "⌘ Tab",
        description: "Switch apps",
        input: { type: "key", key: "tab", modifiers: ["cmd"] },
      },
      {
        label: "⌘ Space",
        description: "Spotlight",
        input: { type: "key", key: "space", modifiers: ["cmd"] },
      },
      {
        label: "⌃ ↑",
        description: "Mission Control",
        input: { type: "key", key: "up", modifiers: ["ctrl"] },
      },
      {
        label: "⌘ W",
        description: "Close window",
        input: { type: "key", key: "w", modifiers: ["cmd"] },
      },
      {
        label: "⌘ Q",
        description: "Quit app",
        input: { type: "key", key: "q", modifiers: ["cmd"] },
      },
      {
        label: "⌥ ⌘ Esc",
        description: "Force Quit",
        input: { type: "key", key: "escape", modifiers: ["cmd", "alt"] },
      },
      {
        label: "⇧ ⌘ 4",
        description: "Screenshot",
        input: { type: "key", key: "4", modifiers: ["cmd", "shift"] },
      },
      { label: "Esc", description: "Escape", input: { type: "key", key: "escape" } },
    ];
  }
  const system = remoteOs === "windows" ? "Win" : "Super";
  return [
    {
      label: "Alt Tab",
      description: "Switch windows",
      input: { type: "key", key: "tab", modifiers: ["alt"] },
    },
    {
      label: `${system} Tab`,
      description: "Task view",
      input: { type: "key", key: "tab", modifiers: ["cmd"] },
    },
    {
      label: `${system} D`,
      description: "Show desktop",
      input: { type: "key", key: "d", modifiers: ["cmd"] },
    },
    {
      label: `${system} R`,
      description: "Run",
      input: { type: "key", key: "r", modifiers: ["cmd"] },
    },
    {
      label: "Ctrl Shift Esc",
      description: "Task Manager",
      input: { type: "key", key: "escape", modifiers: ["ctrl", "shift"] },
    },
    {
      label: "Alt F4",
      description: "Close window",
      input: { type: "key", key: "f4", modifiers: ["alt"] },
    },
    {
      label: `${system} Shift S`,
      description: "Snip",
      input: { type: "key", key: "s", modifiers: ["cmd", "shift"] },
    },
    { label: "Esc", description: "Escape", input: { type: "key", key: "escape" } },
  ];
}

export interface ComputerViewFrameSample {
  readonly at: number;
  readonly bytes: number;
}

/**
 * Frames per second and throughput over the samples inside the window ending
 * at `now`, for the stats overlay. Base64 inflates by 4/3, so the byte count
 * is the decoded size.
 */
export function summarizeComputerViewFrames(
  samples: ReadonlyArray<ComputerViewFrameSample>,
  now: number,
  windowMs = 2_000,
): { readonly framesPerSecond: number; readonly kilobytesPerSecond: number } {
  const recent = samples.filter((sample) => now - sample.at <= windowMs);
  const seconds = windowMs / 1_000;
  const bytes = recent.reduce((total, sample) => total + sample.bytes, 0);
  return {
    framesPerSecond: Math.round((recent.length / seconds) * 10) / 10,
    kilobytesPerSecond: Math.round(bytes / 1_024 / seconds),
  };
}

/** Decoded byte size of a base64 payload. */
export function base64DecodedLength(data: string): number {
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((data.length * 3) / 4) - padding);
}
