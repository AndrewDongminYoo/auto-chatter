# JavaScript conventions

ESLint (`eslint.config.js`, run with `corepack pnpm lint` and by Trunk) owns lint rules, and Prettier (`.prettierrc`) owns layout.
Do not add formatting rules to ESLint.

## Dashboard scripts

`public/app/*.js` are classic scripts that `public/app/index.html` loads in order, so their top-level declarations are page globals.
When a script starts to read a name that another script defines, add the name to that script's group in `dashboardGlobals` in `eslint.config.js`, not a `/* global */` comment.

## Type checking

`corepack pnpm check-types` also runs `tsc -p tsconfig.public.json`, which type-checks `public/app/*.js` without a build step or emitted files.
The configuration reads every dashboard script but reports errors only in a file whose first line is `// @ts-check`.
TypeScript puts the top-level declarations of these classic scripts in one global scope, so the scripts themselves declare the names in `dashboardGlobals`; do not restate them in a `.d.ts` file.
`noImplicitAny` is off, so an unannotated parameter is `any`; add JSDoc only where a check needs it.
The pure model modules carry `// @ts-check`; add it to the screen scripts (`app.js`, `inbox.js`, `flow-editor.js` and the `create*` factories) one file at a time.

## JSDoc

No lint rule enforces JSDoc.
Document module-boundary functions and shared data shapes with `@param`, `@returns` and `@typedef`, in a form that a later `// @ts-check` can read.
Do not add type annotations to local code only to fill in JSDoc.
