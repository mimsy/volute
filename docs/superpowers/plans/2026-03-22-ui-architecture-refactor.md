# UI Architecture Refactor

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor the Svelte frontend into a well-organized, themeable component library with consistent patterns and minimal duplication.

**Architecture:** Extract CSS tokens into a standalone theme file, build missing shared UI primitives (Input, Select, Dropdown), reorganize flat component directory into feature-based subdirectories, and deduplicate env var / form / fetch patterns across settings components.

**Tech Stack:** Svelte 5, CSS custom properties, Vite

---

## File Structure

### New files to create:
- `src/web/ui/src/theme.css` — All CSS custom properties (colors, spacing, typography, z-index, radii)
- `src/web/ui/src/components/ui/Input.svelte` — Shared text/number input component
- `src/web/ui/src/components/ui/Select.svelte` — Shared styled select component
- `src/web/ui/src/components/ui/Dropdown.svelte` — Positioned dropdown menu with click-outside
- `src/web/ui/src/components/ui/EnvVarList.svelte` — Reusable env var editor (extracted from MindInfo + MindSettingsEnv)

### Files to modify:
- `src/web/ui/src/app.css` — Remove CSS variables (moved to theme.css), keep resets/markdown/animations
- `src/web/ui/src/components/MindInfo.svelte` — Use Input/Select, extract env vars to EnvVarList
- `src/web/ui/src/components/MindSettingsCognition.svelte` — Use Input/Select, remove duplicate input CSS
- `src/web/ui/src/components/MindSettingsRhythms.svelte` — Use Input/Select, remove `.input` CSS
- `src/web/ui/src/components/MindSettingsEnv.svelte` — Replace with thin wrapper around EnvVarList
- `src/web/ui/src/components/StatusBar.svelte` — Use Dropdown component
- `src/web/ui/src/components/ConversationList.svelte` — Use Dropdown component for context menu
- `src/web/ui/src/components/MessageInput.svelte` — Use Dropdown component for attach menu
- `src/web/ui/src/components/MindCard.svelte` — Replace hardcoded rgba with CSS variable
- `src/web/ui/src/pages/SetupPage.svelte` — Use Input component
- `src/web/ui/src/components/SeedModal.svelte` — Use Input component
- `src/web/ui/src/components/LoginPage.svelte` — Use Input component
- `src/web/ui/src/components/ChannelBrowserModal.svelte` — Use Input component (replaces `.name-input`)
- `src/web/ui/src/components/ui/TimePicker.svelte` — Use Select component, remove duplicate `.input` CSS

### Files to move (directory reorganization):
```
components/Chat.svelte          → components/chat/Chat.svelte
components/MessageList.svelte   → components/chat/MessageList.svelte
components/MessageEntry.svelte  → components/chat/MessageEntry.svelte
components/MessageInput.svelte  → components/chat/MessageInput.svelte
components/ToolBlock.svelte     → components/chat/ToolBlock.svelte
components/ToolGroup.svelte     → components/chat/ToolGroup.svelte
components/TypingIndicator.svelte → components/chat/TypingIndicator.svelte

components/MindCard.svelte      → components/mind/MindCard.svelte
components/MindInfo.svelte      → components/mind/MindInfo.svelte
components/MindClock.svelte     → components/mind/MindClock.svelte
components/MindSkills.svelte    → components/mind/MindSkills.svelte
components/VariantList.svelte   → components/mind/VariantList.svelte
components/MindSettings.svelte  → components/mind/MindSettings.svelte
components/MindSettingsProfile.svelte   → components/mind/MindSettingsProfile.svelte
components/MindSettingsCognition.svelte → components/mind/MindSettingsCognition.svelte
components/MindSettingsRhythms.svelte   → components/mind/MindSettingsRhythms.svelte
components/MindSettingsEnv.svelte       → components/mind/MindSettingsEnv.svelte
components/MindSettingsAdvanced.svelte  → components/mind/MindSettingsAdvanced.svelte
components/MindRightPanel.svelte        → components/mind/MindRightPanel.svelte

components/Modal.svelte         → components/ui/Modal.svelte
components/TabBar.svelte        → components/ui/TabBar.svelte
components/StatusBadge.svelte   → components/ui/StatusBadge.svelte
components/Icon.svelte          → components/ui/Icon.svelte

components/UserSettingsModal.svelte     → components/modals/UserSettingsModal.svelte
components/AdminModal.svelte            → components/modals/AdminModal.svelte
components/SeedModal.svelte             → components/modals/SeedModal.svelte
components/ChannelBrowserModal.svelte   → components/modals/ChannelBrowserModal.svelte
components/InviteModal.svelte           → components/modals/InviteModal.svelte
components/ReadOnlyChatModal.svelte     → components/modals/ReadOnlyChatModal.svelte
components/AddSkillModal.svelte         → components/modals/AddSkillModal.svelte

components/AiProviders.svelte      → components/system/AiProviders.svelte
components/ImagegenProviders.svelte → components/system/ImagegenProviders.svelte
components/ModelSelect.svelte      → components/system/ModelSelect.svelte
components/SharedSkills.svelte     → components/system/SharedSkills.svelte
components/UserManagement.svelte   → components/system/UserManagement.svelte
components/SystemLogs.svelte       → components/system/SystemLogs.svelte
components/PublicFiles.svelte      → components/system/PublicFiles.svelte
components/UpdateBanner.svelte     → components/system/UpdateBanner.svelte

components/MainFrame.svelte        → components/layout/MainFrame.svelte
components/UnifiedSidebar.svelte   → components/layout/UnifiedSidebar.svelte
components/StatusBar.svelte        → components/layout/StatusBar.svelte
components/ConversationList.svelte → components/layout/ConversationList.svelte
```

Remaining in `components/` (not worth grouping):
- `LogViewer.svelte`, `ProfileHoverCard.svelte`, `HistoryEvent.svelte`, `TurnTimeline.svelte`, `ChannelMembersPanel.svelte`, `ExtensionFeedCard.svelte`, `LoginPage.svelte`

---

## Phase 1: Theme extraction

### Task 1: Extract CSS variables into theme.css

**Files:**
- Create: `src/web/ui/src/theme.css`
- Modify: `src/web/ui/src/app.css`
- Modify: `src/web/ui/src/main.ts`

- [ ] **Step 1: Create `theme.css`**

Create the file with all CSS custom properties extracted from `app.css` lines 1-34, plus new spacing and z-index tokens:

```css
/* theme.css — All design tokens. Override these to create a custom theme. */
:root {
  /* Background layers (darkest → lightest) */
  --bg-0: #0a0c0f;
  --bg-1: #11141a;
  --bg-2: #181c24;
  --bg-3: #1f2430;

  /* Borders */
  --border: #2a3040;
  --border-bright: #3a4560;

  /* Text hierarchy */
  --text-0: #e8ecf4;
  --text-1: #a0aabb;
  --text-2: #6a7588;

  /* Brand */
  --accent: #e0a860;
  --accent-dim: #5c4428;
  --accent-bg: rgba(224, 168, 96, 0.08);
  --accent-border: rgba(224, 168, 96, 0.2);

  /* Status colors */
  --red: #f87171;
  --red-dim: #7f1d1d;
  --red-bg: rgba(248, 113, 113, 0.08);
  --red-border: rgba(248, 113, 113, 0.2);
  --yellow: #fbbf24;
  --yellow-dim: #78350f;
  --yellow-bg: rgba(251, 191, 36, 0.08);
  --blue: #60a5fa;
  --blue-bg: rgba(96, 165, 250, 0.08);
  --purple: #c084fc;
  --green: #4ade80;

  /* Surfaces */
  --overlay: rgba(0, 0, 0, 0.6);
  --muted-bg: rgba(106, 117, 136, 0.08);
  --timeline-rail: #333;

  /* Typography */
  --mono: "Fira Code", "SF Mono", monospace;
  --sans: "Averia Sans Libre", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  --display: "Averia Serif Libre", Georgia, serif;

  /* Radii */
  --radius: 6px;
  --radius-lg: 10px;

  /* Z-index layers */
  --z-dropdown: 100;
  --z-modal: 200;
  --z-toast: 300;
}
```

- [ ] **Step 2: Remove the `:root` block from `app.css`**

Remove lines 1-34 (the entire `:root { ... }` block) from `app.css`. Everything else stays.

- [ ] **Step 3: Import `theme.css` before `app.css` in `main.ts`**

In `src/web/ui/src/main.ts`, add the theme import before the existing `app.css` import:

```typescript
import "./theme.css";
import "./app.css";
```

- [ ] **Step 4: Update z-index references to use new tokens**

In `Modal.svelte` line 69, change `z-index: 200` to `z-index: var(--z-modal)`.

In `StatusBar.svelte` line 183, change `z-index: 100` to `z-index: var(--z-dropdown)`.

In `ConversationList.svelte`, change the context-menu z-index to `var(--z-dropdown)`.

Search for other `z-index` values across `.svelte` files. Only update values that represent semantic layers (dropdowns, modals, toasts) to use tokens. Low z-index values (1-10) used for local stacking contexts within a component should stay as literal numbers — they don't need tokens.

- [ ] **Step 5: Fix the hardcoded rgba in MindCard.svelte**

In `MindCard.svelte`, find `background: rgba(251, 191, 36, 0.08)` and replace with `background: var(--yellow-bg)`.

- [ ] **Step 6: Verify the build succeeds**

Run: `cd src/web/ui && npx vite build`
Expected: Build completes with no errors. All colors render from theme.css.

- [ ] **Step 7: Verify in browser**

Open the dashboard in Chrome and verify the UI looks identical to before the change. Check: sidebar, chat, modals, status bar, settings pages.

- [ ] **Step 8: Commit**

```bash
git add src/web/ui/src/theme.css src/web/ui/src/app.css src/web/ui/src/main.ts src/web/ui/src/components/Modal.svelte src/web/ui/src/components/StatusBar.svelte src/web/ui/src/components/ConversationList.svelte src/web/ui/src/components/MindCard.svelte
git commit -m "refactor: extract CSS tokens into theme.css for custom theming"
```

---

## Phase 2: Shared Input and Select components

### Task 2: Create Input component

**Files:**
- Create: `src/web/ui/src/components/ui/Input.svelte`

- [ ] **Step 1: Create `Input.svelte`**

This component replaces `.setting-input`, `.env-input`, `.input`, and `.name-input` patterns found across 7+ files. It must support all existing variants.

```svelte
<script lang="ts">
import type { HTMLInputAttributes } from "svelte/elements";

let {
  variant = "default",
  width,
  class: className,
  ...rest
}: HTMLInputAttributes & {
  variant?: "default" | "mono";
  width?: string;
  class?: string;
} = $props();
</script>

<input
  class="input {variant} {className ?? ''}"
  style:width={width}
  style:flex={width ? `0 0 ${width}` : undefined}
  {...rest}
/>

<style>
  .input {
    background: var(--bg-2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 4px 8px;
    font-size: 14px;
    font-family: inherit;
    color: var(--text-0);
  }

  .input:focus {
    border-color: var(--accent);
    outline: none;
  }

  .input:disabled {
    opacity: 0.5;
  }

  .mono {
    font-family: var(--mono);
    font-size: 13px;
  }
</style>
```

- [ ] **Step 2: Commit**

```bash
git add src/web/ui/src/components/ui/Input.svelte
git commit -m "feat: add shared Input component"
```

### Task 3: Create Select component

**Files:**
- Create: `src/web/ui/src/components/ui/Select.svelte`

- [ ] **Step 1: Create `Select.svelte`**

```svelte
<script lang="ts">
import type { Snippet } from "svelte";
import type { HTMLSelectAttributes } from "svelte/elements";

let {
  children,
  class: className,
  ...rest
}: HTMLSelectAttributes & {
  children: Snippet;
  class?: string;
} = $props();
</script>

<select class="select {className ?? ''}" {...rest}>
  {@render children()}
</select>

<style>
  .select {
    background: var(--bg-2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 4px 8px;
    font-size: 14px;
    font-family: inherit;
    color: var(--text-0);
  }

  .select:focus {
    border-color: var(--accent);
    outline: none;
  }

  .select:disabled {
    opacity: 0.5;
  }
</style>
```

- [ ] **Step 2: Commit**

```bash
git add src/web/ui/src/components/ui/Select.svelte
git commit -m "feat: add shared Select component"
```

### Task 4: Adopt Input/Select in MindSettingsCognition

**Files:**
- Modify: `src/web/ui/src/components/MindSettingsCognition.svelte`

This is the cleanest file to start with — has straightforward `.setting-input` and `.setting-select` usage.

- [ ] **Step 1: Replace inputs with shared components**

Add imports:
```typescript
import Input from "./ui/Input.svelte";
import Select from "./ui/Select.svelte";
```

Replace every `<input class="setting-input" ...>` with `<Input ...>`. Examples:

Line 170 (model text input):
```svelte
<Input type="text" bind:value={editModel} onblur={() => saveModel(editModel)} placeholder="Model ID" />
```

Lines 213-218 (narrow number inputs for maxThinking, budget, period, compaction):
```svelte
<Input type="number" width="80px" bind:value={editMaxThinking} onblur={saveMaxThinking} placeholder="default" />
```

Line 184 (model select):
```svelte
<Select value={editModel} onchange={handleModelSelect}>
  <option value="">--</option>
  {#each enabledModels as model (model.id)}
    <option value={model.id}>{model.name}</option>
  {/each}
  <option value="__other__">other...</option>
</Select>
```

- [ ] **Step 2: Remove duplicate CSS**

Delete these CSS rules from the `<style>` block:
- `.setting-input, .setting-select` (lines 255-264)
- `.setting-input` (lines 266-268)
- `.setting-input.narrow` (lines 270-273)
- `.setting-select` (lines 275-277)

Keep: `.setting-hint`, `.setting-hint-btn`, `.template-badge`, slider styles.

- [ ] **Step 3: Verify the build succeeds**

Run: `cd src/web/ui && npx vite build`
Expected: Build completes with no errors.

- [ ] **Step 4: Verify in browser**

Open Settings → Cognition tab and verify all inputs render correctly: model select, thinking slider, budget/period inputs, context input.

- [ ] **Step 5: Commit**

```bash
git add src/web/ui/src/components/MindSettingsCognition.svelte
git commit -m "refactor: use shared Input/Select in MindSettingsCognition"
```

### Task 5: Adopt Input/Select in MindSettingsRhythms

**Files:**
- Modify: `src/web/ui/src/components/MindSettingsRhythms.svelte`

- [ ] **Step 1: Replace inputs with shared components**

Add imports:
```typescript
import Input from "./ui/Input.svelte";
import Select from "./ui/Select.svelte";
```

Replace all `<input ... class="input ...">` elements:
- `class="input cron-input"` → `<Input variant="mono" ... />`
- `class="input flex"` → `<Input style="flex:1" ... />`
- `class="input tiny"` → `<Input width="50px" style="text-align:center" ... />`
- `class="input"` on number inputs → `<Input type="number" ... />`

Replace all `<select class="input" ...>` elements → `<Select ...>`.

- [ ] **Step 2: Remove duplicate CSS**

Delete these CSS rules:
- `.input` (lines 629-637)
- `.input:focus` (lines 639-642)
- `.input.flex` (lines 644-646)
- `.input.tiny` (lines 648-652)
- `.input.cron-input` (lines 654-658)

- [ ] **Step 3: Verify in browser**

Open Settings → Rhythms tab. Verify: sleep time pickers, cron inputs, schedule forms (add + edit), frequency selects, message inputs.

- [ ] **Step 4: Commit**

```bash
git add src/web/ui/src/components/MindSettingsRhythms.svelte
git commit -m "refactor: use shared Input/Select in MindSettingsRhythms"
```

### Task 6: Adopt Input in MindInfo

**Files:**
- Modify: `src/web/ui/src/components/MindInfo.svelte`

- [ ] **Step 1: Replace inputs with shared components**

Add imports:
```typescript
import Input from "./ui/Input.svelte";
import Select from "./ui/Select.svelte";
```

Replace:
- `<input class="setting-input" ...>` → `<Input ...>`
- `<input class="setting-input narrow" ...>` → `<Input width="80px" ...>`
- `<select class="setting-select" ...>` → `<Select ...>`
- `<input class="env-input key" ...>` → `<Input variant="mono" width="120px" ...>`
- `<input class="env-input value" ...>` → `<Input variant="mono" style="flex:1" ...>`

- [ ] **Step 2: Remove duplicate CSS**

Delete: `.setting-input`, `.setting-input.narrow`, `.setting-input:focus`, `.setting-select`, `.env-input`, `.env-input.key`, `.env-input.value` rules.

- [ ] **Step 3: Verify in browser**

Check MindInfo panel: model input, thinking select, budget inputs, env var add/edit flows.

- [ ] **Step 4: Commit**

```bash
git add src/web/ui/src/components/MindInfo.svelte
git commit -m "refactor: use shared Input/Select in MindInfo"
```

### Task 7: Adopt Input/Select in remaining components

**Files:**
- Modify: `src/web/ui/src/components/MindSettingsEnv.svelte`
- Modify: `src/web/ui/src/pages/SetupPage.svelte`
- Modify: `src/web/ui/src/components/SeedModal.svelte`
- Modify: `src/web/ui/src/components/LoginPage.svelte`
- Modify: `src/web/ui/src/components/ChannelBrowserModal.svelte`
- Modify: `src/web/ui/src/components/ui/TimePicker.svelte`

- [ ] **Step 1: Update MindSettingsEnv**

Same pattern as MindInfo env section — replace `.env-input` usage with `<Input variant="mono" ...>`. Remove duplicate env CSS.

- [ ] **Step 2: Update TimePicker**

TimePicker lives in `ui/` and duplicates the `.input` CSS. Replace `<select class="input time-select" ...>` with `<Select class="time-select" ...>`. Remove the `.input` and `.input:focus` CSS rules (lines 67-80), keeping only `.time-select` sizing rules.

- [ ] **Step 3: Update ChannelBrowserModal**

Replace `<input class="name-input" ...>` with `<Input ...>`. Remove `.name-input` CSS.

- [ ] **Step 4: Update SetupPage, SeedModal, LoginPage**

In each file, replace `<input class="input ...">` with `<Input ...>`. Remove component-local `.input` CSS rules.

**Important:** `SetupPage.svelte` and `SeedModal.svelte` both have `<textarea class="input textarea">` elements. These should NOT use the Input component (which renders `<input>`). Keep the textarea elements as-is, but their styling needs to be self-contained. Add a scoped `.textarea` class with the same base styles if the `.input` class is being removed, OR keep a minimal `.input` rule just for the textarea. The simplest approach: leave the textarea markup unchanged and only remove `.input` rules that conflict. Textareas can keep their own styling since there's only 2 of them — not worth a component.

- [ ] **Step 5: Verify the build succeeds**

Run: `cd src/web/ui && npx vite build`

- [ ] **Step 6: Verify in browser**

Test: login page, setup wizard, seed modal, env vars settings tab, channel browser modal, time pickers in rhythms.

- [ ] **Step 7: Commit**

```bash
git add src/web/ui/src/components/MindSettingsEnv.svelte src/web/ui/src/pages/SetupPage.svelte src/web/ui/src/components/SeedModal.svelte src/web/ui/src/components/LoginPage.svelte src/web/ui/src/components/ChannelBrowserModal.svelte src/web/ui/src/components/ui/TimePicker.svelte
git commit -m "refactor: use shared Input/Select in remaining components"
```

---

## Phase 3: Shared Dropdown component

### Task 8: Create Dropdown component

**Files:**
- Create: `src/web/ui/src/components/ui/Dropdown.svelte`

This consolidates the 3 different dropdown implementations (StatusBar, MessageInput, ConversationList). It must support:
- Relative positioning (attached to anchor) and fixed positioning (context menu at mouse coords)
- Configurable direction (up/down) and alignment (left/right)
- Click-outside to close
- Escape key to close

- [ ] **Step 1: Create `Dropdown.svelte`**

```svelte
<script lang="ts">
import type { Snippet } from "svelte";
import { onMount } from "svelte";

let {
  open = false,
  onclose,
  direction = "down",
  align = "left",
  position,
  children,
  class: className,
}: {
  open: boolean;
  onclose: () => void;
  direction?: "up" | "down";
  align?: "left" | "right";
  position?: { x: number; y: number };
  children: Snippet;
  class?: string;
} = $props();

let menuEl: HTMLDivElement | undefined = $state();

function handleClickOutside(e: MouseEvent) {
  if (menuEl && !menuEl.contains(e.target as Node)) {
    onclose();
  }
}

function handleKeydown(e: KeyboardEvent) {
  if (e.key === "Escape") {
    e.preventDefault();
    onclose();
  }
}

onMount(() => {
  // Delay adding click listener to avoid closing immediately
  const raf = requestAnimationFrame(() => {
    document.addEventListener("click", handleClickOutside);
  });
  return () => {
    cancelAnimationFrame(raf);
    document.removeEventListener("click", handleClickOutside);
  };
});
</script>

<svelte:window onkeydown={handleKeydown} />

{#if open}
  <div
    bind:this={menuEl}
    class="dropdown {className ?? ''}"
    class:up={direction === "up"}
    class:right={align === "right"}
    class:fixed={!!position}
    style:left={position ? `${position.x}px` : undefined}
    style:top={position ? `${position.y}px` : undefined}
    onclick={(e) => e.stopPropagation()}
  >
    {@render children()}
  </div>
{/if}

<style>
  .dropdown {
    position: absolute;
    top: calc(100% + 4px);
    left: 0;
    background: var(--bg-2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    min-width: 120px;
    padding: 4px 0;
    z-index: var(--z-dropdown, 100);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
    animation: fadeIn 0.1s ease;
  }

  .dropdown.up {
    top: auto;
    bottom: calc(100% + 4px);
    box-shadow: 0 -2px 8px rgba(0, 0, 0, 0.3);
  }

  .dropdown.right {
    left: auto;
    right: 0;
  }

  .dropdown.fixed {
    position: fixed;
    top: unset;
    bottom: unset;
    left: unset;
    right: unset;
  }
</style>
```

- [ ] **Step 2: Commit**

```bash
git add src/web/ui/src/components/ui/Dropdown.svelte
git commit -m "feat: add shared Dropdown component"
```

### Task 9: Adopt Dropdown in StatusBar

**Files:**
- Modify: `src/web/ui/src/components/StatusBar.svelte`

- [ ] **Step 1: Replace custom dropdown markup**

Import Dropdown:
```typescript
import Dropdown from "./ui/Dropdown.svelte";
```

Replace the system menu dropdown (lines 58-81) and user menu dropdown (lines 89-109) with:

```svelte
<div class="menu-anchor">
  <button class="status-btn" onclick={toggleSystemMenu}>
    <span class="dot" class:disconnected={!connectionOk}></span>
    {systemName ?? "daemon"}
  </button>
  <Dropdown open={showSystemMenu} onclose={() => (showSystemMenu = false)} direction="up">
    <button class="dropdown-item" onclick={() => { showSystemMenu = false; onRestart(); }}>
      Restart
    </button>
    {#if isAdmin}
      <button class="dropdown-item" onclick={() => { showSystemMenu = false; onAdminClick(); }}>
        Settings
      </button>
    {/if}
  </Dropdown>
</div>
```

Same pattern for the user menu, adding `align="right"`.

- [ ] **Step 2: Remove old dropdown CSS and click-outside handler**

Remove: `handleClickOutside` function, `svelte:document onclick=` and `svelte:window onblur=` handlers.

Remove CSS: `.dropdown`, `.dropdown.right` rules. Keep `.dropdown-item` styles.

- [ ] **Step 3: Verify in browser**

Click system name in status bar → dropdown should appear above. Click username → dropdown should appear above, right-aligned. Click outside → closes. Press Escape → closes.

- [ ] **Step 4: Commit**

```bash
git add src/web/ui/src/components/StatusBar.svelte
git commit -m "refactor: use shared Dropdown in StatusBar"
```

### Task 10: Adopt Dropdown in MessageInput

**Files:**
- Modify: `src/web/ui/src/components/MessageInput.svelte`

- [ ] **Step 1: Replace attach menu**

Import Dropdown and replace the `.attach-menu` div with:

```svelte
<Dropdown open={showAttach} onclose={() => (showAttach = false)} direction="up">
  <!-- existing attach menu buttons -->
</Dropdown>
```

- [ ] **Step 2: Remove old attach menu CSS and click-outside handler**

Remove `.attach-menu` CSS. Remove the custom click-outside logic for the attach menu.

- [ ] **Step 3: Verify in browser**

Click the attach button in chat → menu appears above. Click outside → closes. Escape → closes.

- [ ] **Step 4: Commit**

```bash
git add src/web/ui/src/components/MessageInput.svelte
git commit -m "refactor: use shared Dropdown in MessageInput"
```

### Task 11: Adopt Dropdown in ConversationList context menu

**Files:**
- Modify: `src/web/ui/src/components/ConversationList.svelte`

- [ ] **Step 1: Replace context menu**

The ConversationList context menu uses fixed positioning at mouse coordinates. Use `position` prop:

```svelte
<Dropdown
  open={!!contextMenu}
  onclose={() => (contextMenu = null)}
  position={contextMenu ? { x: contextMenu.x, y: contextMenu.y } : undefined}
>
  <!-- existing context menu items -->
</Dropdown>
```

- [ ] **Step 2: Remove old context menu CSS and handlers**

Remove `.context-menu` CSS and the custom click-outside/escape/blur handlers. **Keep** the `.context-item` button styling (or rename to `.dropdown-item` for consistency) — these are the menu item styles, not the container. The Dropdown component only provides the container; item styling stays in the consuming component.

- [ ] **Step 3: Verify in browser**

Right-click a conversation → context menu appears at cursor. Click outside → closes. Escape → closes.

- [ ] **Step 4: Commit**

```bash
git add src/web/ui/src/components/ConversationList.svelte
git commit -m "refactor: use shared Dropdown in ConversationList"
```

---

## Phase 4: Deduplicate env var list

### Task 12: Extract EnvVarList component

**Files:**
- Create: `src/web/ui/src/components/ui/EnvVarList.svelte`
- Modify: `src/web/ui/src/components/MindSettingsEnv.svelte`
- Modify: `src/web/ui/src/components/MindInfo.svelte`

MindSettingsEnv.svelte and the env section of MindInfo.svelte are nearly identical — same state, same API calls, same rendering. Extract this into a single reusable component.

- [ ] **Step 1: Create EnvVarList.svelte**

Extract the env var logic from `MindSettingsEnv.svelte` into a self-contained component that takes a `name` prop and manages its own state:

```svelte
<script lang="ts">
import type { MindEnv } from "@volute/api";
import { onMount } from "svelte";
import { SvelteSet } from "svelte/reactivity";
import { deleteMindEnvVar, deleteSharedEnvVar, fetchMindEnv, setMindEnvVar } from "../../lib/client";
import Button from "./Button.svelte";
import EmptyState from "./EmptyState.svelte";
import ErrorMessage from "./ErrorMessage.svelte";
import Input from "./Input.svelte";
import SettingsSection from "./SettingsSection.svelte";

let { name }: { name: string } = $props();

let env = $state<MindEnv | null>(null);
let error = $state("");
let saving = $state<string | null>(null);

let revealedKeys = new SvelteSet<string>();
let addingEnv = $state(false);
let newEnvKey = $state("");
let newEnvValue = $state("");
let editingEnvKey = $state<string | null>(null);
let editingEnvValue = $state("");

let mergedEnv = $derived.by(() => {
  if (!env) return [];
  const merged: { key: string; value: string; source: "shared" | "mind" }[] = [];
  for (const [k, v] of Object.entries(env.shared)) {
    merged.push({ key: k, value: v, source: "shared" });
  }
  for (const [k, v] of Object.entries(env.mind)) {
    const idx = merged.findIndex((e) => e.key === k);
    if (idx >= 0) {
      merged[idx] = { key: k, value: v, source: "mind" };
    } else {
      merged.push({ key: k, value: v, source: "mind" });
    }
  }
  return merged.sort((a, b) => a.key.localeCompare(b.key));
});

async function refresh() {
  try {
    env = await fetchMindEnv(name);
    error = "";
  } catch {
    error = "Failed to load environment";
  }
}

onMount(() => { refresh(); });

function toggleReveal(key: string) {
  if (revealedKeys.has(key)) revealedKeys.delete(key);
  else revealedKeys.add(key);
}

function startEditEnv(key: string, value: string) {
  editingEnvKey = key;
  editingEnvValue = value;
}

async function saveEnvEdit() {
  if (!editingEnvKey) return;
  saving = `env:${editingEnvKey}`;
  error = "";
  try {
    await setMindEnvVar(name, editingEnvKey, editingEnvValue);
    env = await fetchMindEnv(name);
    editingEnvKey = null;
    editingEnvValue = "";
  } catch (e) {
    error = e instanceof Error ? e.message : "Failed to save";
  }
  saving = null;
}

async function deleteEnv(key: string, source: "shared" | "mind") {
  saving = `env:${key}`;
  error = "";
  try {
    if (source === "shared") await deleteSharedEnvVar(key);
    else await deleteMindEnvVar(name, key);
    env = await fetchMindEnv(name);
  } catch (e) {
    error = e instanceof Error ? e.message : "Failed to delete";
  }
  saving = null;
}

async function addEnvVar() {
  if (!newEnvKey.trim()) return;
  saving = "env:add";
  error = "";
  try {
    await setMindEnvVar(name, newEnvKey.trim(), newEnvValue);
    env = await fetchMindEnv(name);
    newEnvKey = "";
    newEnvValue = "";
    addingEnv = false;
  } catch (e) {
    error = e instanceof Error ? e.message : "Failed to add";
  }
  saving = null;
}

function handleKeydown(e: KeyboardEvent, action: () => void) {
  if (e.key === "Enter") action();
}
</script>

<SettingsSection title="Environment Variables">
  {#snippet action()}
    <Button variant="primary" onclick={() => (addingEnv = true)}>Add</Button>
  {/snippet}

  <ErrorMessage message={error} />

  {#if addingEnv}
    <div class="env-add-row">
      <Input variant="mono" width="120px" bind:value={newEnvKey} placeholder="KEY" onkeydown={(e) => handleKeydown(e, addEnvVar)} />
      <Input variant="mono" style="flex:1" bind:value={newEnvValue} placeholder="value" onkeydown={(e) => handleKeydown(e, addEnvVar)} />
      <Button variant="primary" onclick={addEnvVar} disabled={saving !== null}>
        {saving === "env:add" ? "..." : "Add"}
      </Button>
      <Button variant="secondary" onclick={() => (addingEnv = false)}>Cancel</Button>
    </div>
  {/if}

  {#if mergedEnv.length === 0}
    <EmptyState message="No environment variables set." />
  {:else}
    <div class="env-list">
      {#each mergedEnv as entry (entry.key)}
        <div class="env-row">
          {#if editingEnvKey === entry.key}
            <span class="env-key">{entry.key}</span>
            <Input variant="mono" style="flex:1" bind:value={editingEnvValue} onkeydown={(e) => handleKeydown(e, saveEnvEdit)} />
            <Button variant="primary" onclick={saveEnvEdit} disabled={saving !== null}>
              {saving === `env:${entry.key}` ? "..." : "Save"}
            </Button>
            <Button variant="secondary" onclick={() => (editingEnvKey = null)}>Cancel</Button>
          {:else}
            <span class="env-key">
              {entry.key}
              {#if entry.source === "shared"}
                <span class="env-source">shared</span>
              {/if}
            </span>
            <span class="env-value" class:masked={!revealedKeys.has(entry.key)}>
              {#if revealedKeys.has(entry.key)}
                {entry.value}
              {:else}
                --------
              {/if}
            </span>
            <Button variant="icon" onclick={() => toggleReveal(entry.key)} title="Toggle visibility">
              {revealedKeys.has(entry.key) ? "Hide" : "Show"}
            </Button>
            {#if entry.source === "mind"}
              <Button variant="icon" onclick={() => startEditEnv(entry.key, entry.value)} title="Edit">
                Edit
              </Button>
            {/if}
            <Button
              variant="icon"
              onclick={() => deleteEnv(entry.key, entry.source)}
              disabled={saving !== null}
              title="Delete"
            >
              {saving === `env:${entry.key}` ? "..." : "Del"}
            </Button>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</SettingsSection>

<style>
  .env-list {
    display: flex;
    flex-direction: column;
  }

  .env-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 0;
    border-bottom: 1px solid var(--border);
    font-size: 14px;
  }

  .env-row:last-child {
    border-bottom: none;
  }

  .env-add-row {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 0;
    margin-bottom: 8px;
  }

  .env-key {
    font-family: var(--mono);
    font-size: 13px;
    color: var(--text-0);
    flex-shrink: 0;
    min-width: 100px;
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .env-source {
    font-family: inherit;
    font-size: 11px;
    padding: 1px 4px;
    border-radius: 4px;
    background: var(--bg-3);
    color: var(--text-2);
  }

  .env-value {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--mono);
    font-size: 13px;
    color: var(--text-1);
  }

  .env-value.masked {
    color: var(--text-2);
  }
</style>
```

- [ ] **Step 2: Replace MindSettingsEnv with thin wrapper**

Replace the entire contents of `MindSettingsEnv.svelte` with:

```svelte
<script lang="ts">
import EnvVarList from "./ui/EnvVarList.svelte";

let { name }: { name: string } = $props();
</script>

<EnvVarList {name} />
```

- [ ] **Step 3: Remove env var code from MindInfo**

In `MindInfo.svelte`, remove:
- All env-related state variables (revealedKeys, addingEnv, newEnvKey, newEnvValue, editingEnvKey, editingEnvValue)
- All env-related functions (toggleReveal, startEditEnv, saveEnvEdit, deleteEnv, addEnvVar, mergedEnv derived)
- The entire "Environment Variables" SettingsSection template block
- All env-related CSS (.env-list, .env-row, .env-add-row, .env-key, .env-source, .env-value, .env-input)
- The env-related imports (deleteMindEnvVar, deleteSharedEnvVar, fetchMindEnv, setMindEnvVar, SvelteSet)

Replace the removed section with:
```svelte
<EnvVarList {name} />
```

And add the import:
```typescript
import EnvVarList from "./ui/EnvVarList.svelte";
```

Also simplify MindInfo's `refresh()` to only fetch config (no longer needs env).

- [ ] **Step 4: Verify in browser**

Check both places env vars appear: MindInfo panel and Settings → Environment tab. Verify add, edit, reveal, delete all work in both.

- [ ] **Step 5: Commit**

```bash
git add src/web/ui/src/components/ui/EnvVarList.svelte src/web/ui/src/components/MindSettingsEnv.svelte src/web/ui/src/components/MindInfo.svelte
git commit -m "refactor: extract shared EnvVarList component, deduplicate env var code"
```

---

## Phase 5: Move Modal, TabBar, StatusBadge, Icon into ui/

### Task 13: Move general UI components into ui/ directory

**Files:**
- Move: `components/Modal.svelte` → `components/ui/Modal.svelte`
- Move: `components/TabBar.svelte` → `components/ui/TabBar.svelte`
- Move: `components/StatusBadge.svelte` → `components/ui/StatusBadge.svelte`
- Move: `components/Icon.svelte` → `components/ui/Icon.svelte`
- Update: All import paths referencing these components

- [ ] **Step 1: Move the four files**

```bash
cd /Users/aswever/src/volute/src/web/ui/src/components
mv Modal.svelte ui/Modal.svelte
mv TabBar.svelte ui/TabBar.svelte
mv StatusBadge.svelte ui/StatusBadge.svelte
mv Icon.svelte ui/Icon.svelte
```

- [ ] **Step 2: Update all import paths**

Search for imports of these components and update paths. The pattern to find:

```bash
grep -rn 'from.*"\.\/Modal"' src/web/ui/src/
grep -rn 'from.*"\.\/TabBar"' src/web/ui/src/
grep -rn 'from.*"\.\/StatusBadge"' src/web/ui/src/
grep -rn 'from.*"\.\/Icon"' src/web/ui/src/
grep -rn 'from.*"\.\.\/Modal"' src/web/ui/src/
```

For each importing file, change the path:
- `from "./Modal.svelte"` → `from "./ui/Modal.svelte"` (same-level imports)
- `from "../components/Modal.svelte"` → `from "../components/ui/Modal.svelte"` (page-level imports)

Components within `ui/` that import other `ui/` components use `from "./Modal.svelte"`.

- [ ] **Step 3: Verify the build succeeds**

Run: `cd src/web/ui && npx vite build`
Expected: Build completes with no errors.

- [ ] **Step 4: Commit**

```bash
git add -A src/web/ui/src/components/
git commit -m "refactor: move Modal, TabBar, StatusBadge, Icon into ui/ directory"
```

---

## Phase 6: Directory reorganization

### Task 14: Create feature directories and move chat components

**Files:**
- Move: 7 chat-related components into `components/chat/`
- Update: All import paths

- [ ] **Step 1: Create directory and move files**

```bash
mkdir -p src/web/ui/src/components/chat
cd src/web/ui/src/components
mv Chat.svelte MessageList.svelte MessageEntry.svelte MessageInput.svelte ToolBlock.svelte ToolGroup.svelte TypingIndicator.svelte chat/
```

- [ ] **Step 2: Update all import paths**

Search for all imports of moved files and update. Components within `chat/` that import each other use `./` relative paths. Components outside `chat/` use `./chat/...` or `../components/chat/...`.

- [ ] **Step 3: Verify the build succeeds**

Run: `cd src/web/ui && npx vite build`

- [ ] **Step 4: Commit**

```bash
git add -A src/web/ui/src/
git commit -m "refactor: move chat components into components/chat/"
```

### Task 15: Move mind components

**Files:**
- Move: 11 mind-related components into `components/mind/`
- Update: All import paths

- [ ] **Step 1: Create directory and move files**

```bash
mkdir -p src/web/ui/src/components/mind
cd src/web/ui/src/components
mv MindCard.svelte MindInfo.svelte MindClock.svelte MindSkills.svelte VariantList.svelte MindSettings.svelte MindSettingsProfile.svelte MindSettingsCognition.svelte MindSettingsRhythms.svelte MindSettingsEnv.svelte MindSettingsAdvanced.svelte MindRightPanel.svelte mind/
```

- [ ] **Step 2: Update all import paths**

Update imports in all files that reference the moved mind components. Also update imports within the moved files that reference each other or ui/ components (e.g., `from "./ui/Button.svelte"` → `from "../ui/Button.svelte"`).

- [ ] **Step 3: Verify the build succeeds**

Run: `cd src/web/ui && npx vite build`

- [ ] **Step 4: Commit**

```bash
git add -A src/web/ui/src/
git commit -m "refactor: move mind components into components/mind/"
```

### Task 16: Move modal components

**Files:**
- Move: 7 modal components into `components/modals/`
- Update: All import paths

- [ ] **Step 1: Create directory and move files**

```bash
mkdir -p src/web/ui/src/components/modals
cd src/web/ui/src/components
mv UserSettingsModal.svelte AdminModal.svelte SeedModal.svelte ChannelBrowserModal.svelte InviteModal.svelte ReadOnlyChatModal.svelte AddSkillModal.svelte modals/
```

- [ ] **Step 2: Update all import paths**

- [ ] **Step 3: Verify the build succeeds**

Run: `cd src/web/ui && npx vite build`

- [ ] **Step 4: Commit**

```bash
git add -A src/web/ui/src/
git commit -m "refactor: move modal components into components/modals/"
```

### Task 17: Move system and layout components

**Files:**
- Move: 8 system components into `components/system/`
- Move: 4 layout components into `components/layout/`
- Update: All import paths

- [ ] **Step 1: Create directories and move files**

```bash
mkdir -p src/web/ui/src/components/system src/web/ui/src/components/layout
cd src/web/ui/src/components
mv AiProviders.svelte ImagegenProviders.svelte ModelSelect.svelte SharedSkills.svelte UserManagement.svelte SystemLogs.svelte PublicFiles.svelte UpdateBanner.svelte system/
mv MainFrame.svelte UnifiedSidebar.svelte StatusBar.svelte ConversationList.svelte layout/
```

- [ ] **Step 2: Update all import paths**

- [ ] **Step 3: Verify the build succeeds**

Run: `cd src/web/ui && npx vite build`

- [ ] **Step 4: Verify in browser**

Full walkthrough: login, home page, open a mind, chat, open settings (all tabs), modals (seed, channel browser, admin), system settings, logs. Everything should work exactly as before.

- [ ] **Step 5: Commit**

```bash
git add -A src/web/ui/src/
git commit -m "refactor: move system and layout components into feature directories"
```

---

## Phase 7: Stop button and accessibility quick wins

### Task 18: Replace inline stop button with Button component

**Files:**
- Modify: `src/web/ui/src/components/mind/MindInfo.svelte`

- [ ] **Step 1: Replace the stop button**

In `MindInfo.svelte`, replace the custom `.action-btn.stop-btn`:

```svelte
<button onclick={handleStop} disabled={actionLoading} class="action-btn stop-btn">
  {actionLoading ? "Stopping..." : "Stop"}
</button>
```

With:
```svelte
<Button variant="danger" onclick={handleStop} disabled={actionLoading}>
  {actionLoading ? "Stopping..." : "Stop"}
</Button>
```

Remove `.action-btn` and `.stop-btn` CSS rules.

Note: Button's `danger` variant currently shows red on hover only. This is fine — the "Stop" text already conveys the action. If you want a more visible danger style, you could add a `destructive` variant to Button later, but don't add it now.

- [ ] **Step 2: Commit**

```bash
git add src/web/ui/src/components/mind/MindInfo.svelte
git commit -m "refactor: use Button component for stop action in MindInfo"
```

### Task 19: Add aria-labels to icon buttons

**Files:**
- Modify: `src/web/ui/src/components/chat/MessageInput.svelte`
- Modify: `src/web/ui/src/components/layout/StatusBar.svelte`

- [ ] **Step 1: Add aria-labels to MessageInput buttons**

Find buttons that have icons but no text or aria-label. Add `aria-label` attributes:
- Send button: `aria-label="Send message"`
- Attach button: `aria-label="Attach file"`
- Any other icon-only buttons

- [ ] **Step 2: Add aria-labels to StatusBar**

- System menu button: already has text content, OK.
- Username button: already has text content, OK.
- Check if any icon-only buttons exist.

- [ ] **Step 3: Search for other icon buttons missing labels**

```bash
grep -rn 'variant="icon"' src/web/ui/src/ | grep -v 'title='
```

Any `variant="icon"` Button without a `title` attribute should get one.

- [ ] **Step 4: Commit**

```bash
git add -A src/web/ui/src/
git commit -m "fix: add aria-labels to icon buttons for accessibility"
```

---

## Phase 8: Final verification

### Task 20: Full build and visual verification

- [ ] **Step 1: Clean build**

```bash
cd /Users/aswever/src/volute
npm run build
```

Expected: Both CLI (tsup) and frontend (vite) builds succeed.

- [ ] **Step 2: Run tests**

```bash
npm test
```

Expected: All existing tests pass.

- [ ] **Step 3: Visual verification in browser**

Start the daemon and open the dashboard. Walk through every screen:
1. Login page
2. Home/feed page
3. Mind chat (send a message)
4. Mind settings → all tabs (Profile, Cognition, Rhythms, Environment, Advanced)
5. System settings
6. Modals: seed, channel browser, admin, user settings
7. Status bar dropdowns (system menu, user menu)
8. Conversation list context menu (right-click)
9. Message input attach menu

Verify nothing is visually broken.

- [ ] **Step 4: Verify theme customization works**

Create a quick test: in `theme.css`, temporarily change `--accent: #e0a860` to `--accent: #60a5e0` (blue). Reload the dashboard. Verify that ALL accent-colored elements change — buttons, active states, focus rings, status dots, etc. Revert the change.

This confirms the theme extraction is complete and custom theming works.

---

## Summary

| Phase | Tasks | What it accomplishes |
|-------|-------|---------------------|
| 1 | 1 | Theme extraction — enables custom themes |
| 2 | 2-7 | Shared Input/Select — eliminates ~9 duplicate input style blocks |
| 3 | 8-11 | Shared Dropdown — consolidates 3 menu implementations |
| 4 | 12 | EnvVarList extraction — removes ~200 lines of duplicated env var code |
| 5 | 13 | Move UI primitives to ui/ — cleaner imports |
| 6 | 14-17 | Directory reorganization — feature-based grouping |
| 7 | 18-19 | Button consolidation + accessibility |
| 8 | 20 | Final verification |

After all phases, the component directory will look like:
```
components/
├── ui/          # 12 shared primitives (Button, Input, Select, Dropdown, Modal, etc.)
├── chat/        # 7 chat components
├── mind/        # 12 mind components
├── modals/      # 7 modal dialogs
├── system/      # 8 system/admin components
├── layout/      # 4 layout components
└── (7 misc)     # LogViewer, ProfileHoverCard, LoginPage, etc.
```
