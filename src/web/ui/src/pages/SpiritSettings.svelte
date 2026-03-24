<script lang="ts">
import type { Mind } from "@volute/api";
import { SectionHeader } from "@volute/ui";
import { onMount } from "svelte";
import MindSettingsCognition from "../components/mind/MindSettingsCognition.svelte";
import MindSettingsEnv from "../components/mind/MindSettingsEnv.svelte";
import MindSettingsProfile from "../components/mind/MindSettingsProfile.svelte";
import MindSkills from "../components/mind/MindSkills.svelte";
import { fetchMind } from "../lib/client";

let mind = $state<Mind | null>(null);
let error = $state("");

const SECTIONS = [
  { id: "profile", label: "Profile" },
  { id: "cognition", label: "Model" },
  { id: "skills", label: "Skills" },
  { id: "environment", label: "Environment" },
] as const;

let activeSection = $state("profile");
let scrollContainer = $state<HTMLDivElement>(undefined!);
let sectionEls: Record<string, HTMLElement> = {};
let manualClick = false;

onMount(() => {
  loadSpirit();
  setupObserver();
});

async function loadSpirit() {
  try {
    mind = await fetchMind("volute");
  } catch (e) {
    error = e instanceof Error ? e.message : "Failed to load spirit";
  }
}

function setupObserver() {
  if (!scrollContainer) return;
  const observer = new IntersectionObserver(
    (entries) => {
      if (manualClick) return;
      for (const entry of entries) {
        if (entry.isIntersecting) {
          activeSection = entry.target.id;
        }
      }
    },
    { root: scrollContainer, rootMargin: "-20% 0px -70% 0px", threshold: 0 },
  );
  for (const el of Object.values(sectionEls)) {
    if (el) observer.observe(el);
  }
  return () => observer.disconnect();
}

function scrollTo(id: string) {
  activeSection = id;
  manualClick = true;
  sectionEls[id]?.scrollIntoView({ behavior: "smooth", block: "start" });
  setTimeout(() => {
    manualClick = false;
  }, 600);
}
</script>

{#if error}
  <div class="error">{error}</div>
{:else if mind}
  <div class="settings">
    <nav class="section-nav">
      {#each SECTIONS as s}
        <button
          class="nav-pill"
          class:active={activeSection === s.id}
          onclick={() => scrollTo(s.id)}
        >{s.label}</button>
      {/each}
    </nav>

    <div class="settings-body" bind:this={scrollContainer}>
      <section id="profile" bind:this={sectionEls.profile}>
        <MindSettingsProfile {mind} onUpdated={loadSpirit} />
      </section>

      <section id="cognition" bind:this={sectionEls.cognition}>
        <SectionHeader title="Model" subtitle="Cognition settings" />
        <MindSettingsCognition name={mind.name} template={mind.template} hideBudget />
      </section>

      <section id="skills" bind:this={sectionEls.skills}>
        <MindSkills name={mind.name} />
      </section>

      <section id="environment" bind:this={sectionEls.environment}>
        <MindSettingsEnv name={mind.name} />
      </section>
    </div>
  </div>
{/if}

<style>
  .settings {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    overflow: hidden;
    animation: fadeIn 0.2s ease both;
  }

  .section-nav {
    display: flex;
    gap: 4px;
    padding: 8px 16px;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
    overflow-x: auto;
    background: var(--bg-0);
  }

  .nav-pill {
    padding: 4px 12px;
    border-radius: 12px;
    font-size: 12px;
    font-weight: 500;
    background: none;
    color: var(--text-2);
    border: 1px solid transparent;
    white-space: nowrap;
    transition: color 0.15s, background 0.15s;
  }

  .nav-pill:hover {
    color: var(--text-1);
    background: var(--bg-2);
  }

  .nav-pill.active {
    background: var(--accent-dim);
    color: var(--accent);
  }

  .settings-body {
    flex: 1;
    min-height: 0;
    overflow: auto;
  }

  section {
    padding: 24px 16px 8px;
    max-width: 720px;
    margin: 0 auto;
  }

  .error {
    color: var(--red);
    font-size: 13px;
    padding: 24px 16px;
  }
</style>
