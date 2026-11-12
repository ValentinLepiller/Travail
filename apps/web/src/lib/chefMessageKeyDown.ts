import type { KeyboardEvent } from "react";

export function chefMessageKeyDown(
  event: KeyboardEvent<HTMLTextAreaElement>,
  update: (text: string) => void,
) {
  if (
    event.key !== "Enter" ||
    event.shiftKey ||
    event.altKey ||
    event.metaKey ||
    event.nativeEvent.isComposing ||
    event.nativeEvent.keyCode === 229
  )
    return;
  event.preventDefault();
  if (event.ctrlKey) {
    const input = event.currentTarget;
    if (input.value.length - (input.selectionEnd - input.selectionStart) < input.maxLength) {
      input.setRangeText("\n", input.selectionStart, input.selectionEnd, "end");
      update(input.value);
    }
  } else if (!event.repeat) event.currentTarget.form?.requestSubmit();
}
