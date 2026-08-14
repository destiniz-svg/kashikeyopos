/// <reference types="vite/client" />

/* The API origin is configured at build time so the deployed static bundle
   carries no same-origin assumption. Declared here rather than read with a
   cast, so a typo in the variable name is a compile error and not an
   undefined at runtime. */
interface ImportMetaEnv {
  readonly VITE_API_ORIGIN?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
