// Stable import path for the palette/picker text-input + spinner widgets.
// Hand-rolled (see P03-T04 / Q11): @inkjs/ui renders under Ink 7 but fails the
// Native `--bytecode` bundle and ships an uncontrolled TextInput, so the palette
// Depends on these wrappers instead — swappable without touching consumers.
export { Spinner } from "./Spinner.js";
export type { SpinnerProps } from "./Spinner.js";
export { TextInput } from "./TextInput.js";
export type { TextInputProps } from "./TextInput.js";
