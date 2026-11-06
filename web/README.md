# LeanSeal web

Run `npm install` and `npm run dev` from this directory. Build with `npm run build` and validate TypeScript/Astro with `npm run check`.

## Component setup

The site uses Astro 5 with React islands, TypeScript, and Tailwind CSS 4 through `@tailwindcss/vite`. Tailwind utilities and theme tokens are loaded in `src/styles/global.css`; preflight is omitted to preserve the existing page styles. Landing-page styles live in `src/styles/compile.css` and dashboard styles in `src/styles/dashboard.css`.

Reusable UI components live in `src/components/ui`, imported as `@/components/ui`. This is the source-directory equivalent of `/components/ui`; it keeps shared React components separate from pages and dashboard components and gives the shadcn CLI a consistent installation target. `components.json` configures the aliases, styles, TypeScript, and Tailwind paths. The `cn` helper is in `src/lib/utils.ts`.

The project is already configured. To add a shadcn component later, run `npx shadcn@latest add <component>` from `web/`. For a fresh Astro project, use `npx astro add react`, install `tailwindcss @tailwindcss/vite`, configure the Vite plugin and `@/*` TypeScript alias, then run `npx shadcn@latest init`. Official setup: https://ui.shadcn.com/docs/installation/astro and https://tailwindcss.com/docs/installation/framework-guides/astro.

## Landing-page interactions

`src/components/ConsolePreview.tsx` uses local React state for its four tabs. It is an informational walkthrough; selecting a tab does not submit transactions or call the backend. Click, arrow keys, Home, and End select a panel. The tab controls remain available on mobile.

`src/components/ui/halftone-wordmark-footer.tsx` contains the supplied canvas footer, adapted for reduced-motion behavior. `src/components/ui/demo.tsx` configures its LeanSeal wordmark, paper palette, internal links, and responsive height. Astro hydrates the footer when it approaches the viewport. No providers, image downloads, or icon packages are needed for these components.
