import { Text, useInput } from "ink";
import { useState } from "react";

export interface TextInputProps {
  /** The current value — this input is fully controlled. */
  value: string;
  /** Called with the next value on every edit. */
  onChange: (value: string) => void;
  /** Called with the current value when Enter is pressed. */
  onSubmit?: (value: string) => void;
  /** Dimmed hint shown when the value is empty. */
  placeholder?: string;
  /** Whether this input owns keystrokes (gated by the overlay/router). Default true. */
  isActive?: boolean;
}

/**
 * A minimal controlled single-line text input. The parent owns the value; this
 * component renders it with a block cursor and translates keystrokes into
 * `onChange`/`onSubmit` calls. Input ownership is gated by `isActive`, matching
 * the overlay/input-router model (it never self-manages focus).
 */
export function TextInput({
  value,
  onChange,
  onSubmit,
  placeholder,
  isActive = true,
}: TextInputProps) {
  const [cursor, setCursor] = useState(value.length);
  // Clamp against external value changes (e.g. a reset to "").
  const pos = Math.min(cursor, value.length);

  useInput(
    (input, key) => {
      if (key.return) {
        onSubmit?.(value);
        return;
      }
      if (key.leftArrow) {
        setCursor(Math.max(0, pos - 1));
        return;
      }
      if (key.rightArrow) {
        setCursor(Math.min(value.length, pos + 1));
        return;
      }
      if (key.backspace || key.delete) {
        if (pos > 0) {
          onChange(value.slice(0, pos - 1) + value.slice(pos));
          setCursor(pos - 1);
        }
        return;
      }
      // Printable text only — ignore control chords and bare navigation events.
      if (input && !key.ctrl && !key.meta && !key.escape && !key.tab) {
        onChange(value.slice(0, pos) + input + value.slice(pos));
        setCursor(pos + input.length);
      }
    },
    { isActive },
  );

  if (value.length === 0) {
    return (
      <Text>
        {isActive ? <Text inverse> </Text> : null}
        <Text dimColor>{placeholder ?? ""}</Text>
      </Text>
    );
  }

  const before = value.slice(0, pos);
  const atCursor = value.slice(pos, pos + 1) || " ";
  const after = value.slice(pos + 1);
  return (
    <Text>
      {before}
      {isActive ? <Text inverse>{atCursor}</Text> : atCursor}
      {after}
    </Text>
  );
}
