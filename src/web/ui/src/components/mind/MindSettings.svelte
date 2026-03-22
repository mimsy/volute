<script lang="ts">
import type { Mind } from "@volute/api";
import { onMount } from "svelte";
import { fetchMinds } from "../../lib/client";
import { data } from "../../lib/stores.svelte";
import SectionHeader from "../ui/SectionHeader.svelte";
import MindSettingsCognition from "./MindSettingsCognition.svelte";
import MindSettingsEnv from "./MindSettingsEnv.svelte";
import MindSettingsProfile from "./MindSettingsProfile.svelte";
import MindSettingsRhythms from "./MindSettingsRhythms.svelte";
import MindSkills from "./MindSkills.svelte";

let { mind: initialMind }: { mind: Mind } = $props();

let mind = $derived(data.minds.find((m) => m.name === initialMind.name) ?? initialMind);
let name = $derived(mind.name);

const SECTIONS = [
  { id: "profile", label: "Profile" },
  { id: "cognition", label: "Model" },
  { id: "rhythms", label: "Rhythms" },
  { id: "skills", label: "Skills" },
  { id: "environment", label: "Environment" },
] as const;

let activeSection = $state("profile");
let scrollContainer: HTMLDivElement;
let sectionEls: Record<string, HTMLElement> = {};
let manualClick = false;

onMount(() => {
  setupObserver();
});

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

async function handleUpdated() {
  data.minds = await fetchMinds();
}
</script>

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
      <MindSettingsProfile {mind} onUpdated={handleUpdated} />
    </section>

    <section id="cognition" bind:this={sectionEls.cognition}>
      <SectionHeader title="Model" subtitle="Cognition and resource limits" />
      <MindSettingsCognition {name} template={mind.template} />
    </section>

    <section id="rhythms" bind:this={sectionEls.rhythms}>
      <SectionHeader title="Rhythms" subtitle="Sleep, schedules, and wake triggers" />
      <MindSettingsRhythms {name} />
    </section>

    <section id="skills" bind:this={sectionEls.skills}>
      <MindSkills {name} />
    </section>

    <section id="environment" bind:this={sectionEls.environment}>
      <MindSettingsEnv {name} />
    </section>
  </div>
</div>

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

</style>
