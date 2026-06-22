// Stable import path for the palette/picker text-input + spinner widgets.
// Hand-rolled (see P03-T04 / Q11): @inkjs/ui renders under Ink 7 and bundles fine
// In the native `--bytecode` binary, but its TextInput is uncontrolled (it
// Self-manages value + focus, fighting our overlay/isActive model) and its
// Spinner ignores our icon tier. These wrappers give a controlled, tier-aware
// Contract — swappable for @inkjs/ui without touching consumers if that changes.
export { Spinner } from "./Spinner.js";
export type { SpinnerProps } from "./Spinner.js";
export { TextInput } from "./TextInput.js";
export type { TextInputProps } from "./TextInput.js";
