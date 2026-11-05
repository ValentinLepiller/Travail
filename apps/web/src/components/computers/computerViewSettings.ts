/**
 * Viewer preferences for Computer View, kept in this browser the way a remote
 * desktop client keeps its session options. Every key is optional in storage
 * so a newer build adding a setting never discards what was saved before.
 */
import { COMPUTER_VIEW_MAX_FRAME_RATE, ComputerViewQuality } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useCallback, useMemo } from "react";

import { useLocalStorage } from "~/hooks/useLocalStorage";

const COMPUTER_VIEW_SETTINGS_KEY = "mtcode:computer-view-settings";

export interface ComputerViewSettings {
  /** Fit the whole remote screen in the window; off shows it at actual size with scrollbars. */
  readonly scaleToFit: boolean;
  /** Stream at the display's device pixel ratio, for a sharper picture on Retina screens. */
  readonly highDpi: boolean;
  /** Smooth scaling when the picture is resized; off keeps pixels crisp. */
  readonly smoothScaling: boolean;
  readonly frameRate: number;
  readonly quality: ComputerViewQuality;
  /** Clicks, keys and scrolling go to the remote machine; off is view only. */
  readonly remoteControl: boolean;
  /** Cmd shortcuts on a Mac arrive as Ctrl on Windows and Linux, and the other way round. */
  readonly mapShortcuts: boolean;
  /** Pasting in the viewer types this computer's clipboard on the remote machine. */
  readonly syncClipboard: boolean;
  readonly showStats: boolean;
  /** Keep the toolbar visible in fullscreen instead of sliding it away. */
  readonly pinToolbar: boolean;
}

export const COMPUTER_VIEW_FRAME_RATES = [2, 5, 8, 15, 30] as const;

const DEFAULT_COMPUTER_VIEW_SETTINGS: ComputerViewSettings = {
  scaleToFit: true,
  highDpi: true,
  smoothScaling: true,
  frameRate: 8,
  quality: "standard",
  remoteControl: true,
  mapShortcuts: true,
  syncClipboard: true,
  showStats: false,
  pinToolbar: false,
};

const StoredComputerViewSettings = Schema.Struct({
  scaleToFit: Schema.optionalKey(Schema.Boolean),
  highDpi: Schema.optionalKey(Schema.Boolean),
  smoothScaling: Schema.optionalKey(Schema.Boolean),
  frameRate: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: COMPUTER_VIEW_MAX_FRAME_RATE })),
  ),
  quality: Schema.optionalKey(ComputerViewQuality),
  remoteControl: Schema.optionalKey(Schema.Boolean),
  mapShortcuts: Schema.optionalKey(Schema.Boolean),
  syncClipboard: Schema.optionalKey(Schema.Boolean),
  showStats: Schema.optionalKey(Schema.Boolean),
  pinToolbar: Schema.optionalKey(Schema.Boolean),
});
type StoredComputerViewSettings = typeof StoredComputerViewSettings.Type;
const NO_STORED_SETTINGS: StoredComputerViewSettings = {};

export function useComputerViewSettings(): readonly [
  ComputerViewSettings,
  (patch: Partial<ComputerViewSettings>) => void,
] {
  const [stored, setStored] = useLocalStorage<
    StoredComputerViewSettings,
    typeof StoredComputerViewSettings.Encoded
  >(COMPUTER_VIEW_SETTINGS_KEY, NO_STORED_SETTINGS, StoredComputerViewSettings);
  const settings = useMemo(() => ({ ...DEFAULT_COMPUTER_VIEW_SETTINGS, ...stored }), [stored]);
  const update = useCallback(
    (patch: Partial<ComputerViewSettings>) => setStored((current) => ({ ...current, ...patch })),
    [setStored],
  );
  return [settings, update] as const;
}
