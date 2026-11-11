# JavaScript conventions

ESLint (`eslint.config.js`, run with `corepack pnpm lint` and by Trunk) owns lint rules, and Prettier (`.prettierrc`) owns layout.
Do not add formatting rules to ESLint.

## Dashboard scripts

`public/app/*.js` are classic scripts that `public/app/index.html` loads in order, so their top-level declarations are page globals.
When a script starts to read a name that another script defines, add the name to that script's group in `dashboardGlobals` in `eslint.config.js`, not a `/* global */` comment.

## JSDoc

No lint rule enforces JSDoc.
Document module-boundary functions and shared data shapes with `@param`, `@returns` and `@typedef`, in a form that a later `// @ts-check` can read.
Do not add type annotations to local code only to fill in JSDoc.
