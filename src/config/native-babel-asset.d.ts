// Jiti's exports map does not expose `dist/babel.cjs`; Bun resolves the file
// Directly. Declare it so TypeScript accepts the `type: "text"` import in
// Native-babel.ts (the import evaluates to the file's source contents at runtime).
declare module "jiti/dist/babel.cjs" {
  const source: string;
  export default source;
}
