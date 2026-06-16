// Jiti's exports map does not expose `dist/babel.cjs`; Bun resolves the file
// Asset directly. Declare it so TypeScript accepts the `type: "file"` import in
// Native-babel.ts (the import evaluates to the asset's path string at runtime).
declare module "jiti/dist/babel.cjs" {
  const assetPath: string;
  export default assetPath;
}
