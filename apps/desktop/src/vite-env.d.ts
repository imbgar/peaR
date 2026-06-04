// TypeScript 6 (error TS2882) requires a *side-effect* import to resolve to a module
// that has type declarations. Our CSS and webfont imports are handled by Vite at build
// time and ship no `.d.ts`, so declare them as ambient modules. Covers:
//   import "@xterm/xterm/css/xterm.css";          // *.css
//   import "@fontsource/ibm-plex-mono/400.css";   // *.css
//   import "@fontsource-variable/hanken-grotesk";  // @fontsource-variable/*
declare module "*.css";
declare module "@fontsource-variable/*";
