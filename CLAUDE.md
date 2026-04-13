# Figma MCP Integration Rules

These rules define how to translate Figma inputs into code for this project. Follow them for every Figma-driven change.

## Monorepo Structure

This is a Bun workspace monorepo:

- `packages/ui/` — shared design system (`@opencode-ai/ui`)
  - Components: `packages/ui/src/components/` — exported as `@opencode-ai/ui/<component-name>`
  - Design tokens (CSS variables): `packages/ui/src/styles/`
    - Colors: `packages/ui/src/styles/colors.css`
    - Typography, spacing, radius, shadows: `packages/ui/src/styles/theme.css`
- `packages/app/` — main application (`@opencode-ai/app`)
  - Pages: `packages/app/src/pages/`
  - Feature components: `packages/app/src/components/`
  - Contexts: `packages/app/src/context/`
  - Utils: `packages/app/src/utils/`
  - Path alias `@/` maps to `packages/app/src/`

## Framework & Languages

- **Primary UI framework**: SolidJS (`solid-js`) — use SolidJS primitives (`createSignal`, `createMemo`, `Show`, `For`, etc.)
- **React**: Only used in specific pages/components that already use it (e.g., workflow panel). Do not introduce React into SolidJS files.
- **Language**: TypeScript (strict)
- **Build**: Vite + Bun

## Component Organization

- IMPORTANT: Always check `packages/ui/src/components/` for existing components before creating new ones
- Import UI components using the package alias: `import { Button } from "@opencode-ai/ui/button"`
- New reusable UI components go in `packages/ui/src/components/<component-name>.tsx` with a matching `<component-name>.css` for component-specific styles
- New app-level feature components go in `packages/app/src/components/`
- Page-level components go alongside their page file in `packages/app/src/pages/<page>/`

## Styling Rules

- IMPORTANT: Never hardcode color hex values — always use CSS variables from `packages/ui/src/styles/colors.css`
- IMPORTANT: Never hardcode spacing, font sizes, or border radii — use CSS variables from `packages/ui/src/styles/theme.css`
- Use Tailwind utility classes for layout and spacing in JSX/TSX
- Component-specific styles go in a co-located `.css` file (e.g., `button.css` next to `button.tsx`)
- The project uses `light-dark()` CSS function for automatic light/dark theming — use it in CSS custom properties
- Use `clsx` or SolidJS `classList` prop for conditional class merging; use `tailwind-merge` when Tailwind classes may conflict

### Key CSS Variable Reference

```
/* Typography */
--font-family-sans, --font-family-mono
--font-size-small (13px), --font-size-base (14px), --font-size-large (16px), --font-size-x-large (20px)
--font-weight-regular (400), --font-weight-medium (500)
--line-height-normal (130%), --line-height-large (150%)

/* Spacing base */
--spacing: 0.25rem  (Tailwind default scale applies)

/* Border radius */
--radius-xs (0.125rem), --radius-sm (0.25rem), --radius-md (0.375rem), --radius-lg (0.5rem), --radius-xl (0.625rem)

/* Shadows */
--shadow-xs, --shadow-md, --shadow-lg

/* Colors (examples) */
--gray-dark-1 through --gray-dark-12
--gray-light-1 through --gray-light-12
--gray-dark-alpha-*, --gray-light-alpha-*
```

## Component Patterns

- Components use `data-*` attributes for variants, not CSS class-based variants:
  ```tsx
  <button data-component="button" data-variant="primary" data-size="normal" />
  ```
- Variant props use union types: `variant?: "primary" | "secondary" | "ghost"`
- Size props use union types: `size?: "small" | "normal" | "large"`
- Use `@kobalte/core` as the accessible primitive base for interactive components (buttons, dialogs, selects, etc.)
- Components accept `class` and `classList` props for composition — always forward them
- Use `splitProps` from `solid-js` to separate component-specific props from passthrough props

## Import Conventions

- Use path alias `@/` for imports within `packages/app/src/` (e.g., `import { useLayout } from "@/context/layout"`)
- Use package name for cross-package imports (e.g., `import { Button } from "@opencode-ai/ui/button"`)
- Use `@opencode-ai/sdk/v2` for SDK types
- Group imports: solid-js primitives, third-party, internal `@opencode-ai/*`, then local `@/`

## Icons & Assets

- IMPORTANT: Do NOT install new icon packages
- Icons use a spritesheet system via `vite-plugin-icons-spritesheet`; use the `<Icon>` component from `@opencode-ai/ui/icon`
- `lucide-react` is available for React-context pages only
- If the Figma MCP server returns a localhost source for an image or SVG, use that source directly — do not create placeholders
- Static assets go in `packages/app/src/assets/` or `packages/ui/src/assets/`

## Required Figma Implementation Flow

1. Run `get_design_context` for the target Figma node(s)
2. Run `get_screenshot` for visual reference of the variant being implemented
3. If `get_design_context` response is too large, run `get_metadata` first to get the node map, then fetch only the required nodes
4. Download any required assets from the Figma localhost endpoint
5. Translate the output into SolidJS (not React) using this project's conventions, tokens, and existing components
6. Validate the final UI against the Figma screenshot for 1:1 visual parity before marking complete

## Translation Rules (Figma MCP output -> project code)

- Figma MCP output is typically React + Tailwind — treat it as a design representation, not final code
- Convert React JSX to SolidJS JSX:
  - `useState` -> `createSignal`
  - `useEffect` -> `createEffect`
  - `useMemo` -> `createMemo`
  - Conditional rendering: replace ternary JSX with `<Show when={...}>` / `<Switch>` / `<Match>`
  - List rendering: replace `.map()` with `<For each={...}>`
- Replace Tailwind color utilities with CSS variable references where design tokens exist
- Replace any hardcoded Radix UI or shadcn/ui components with `@kobalte/core` equivalents or existing `@opencode-ai/ui` components

## Testing

- Unit tests: `bun test` — co-located as `<file>.test.ts` next to the source file
- E2E tests: Playwright in `packages/app/e2e/`
- Run unit tests with: `cd packages/app && bun test`
