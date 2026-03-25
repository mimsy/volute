<script lang="ts">
import type { Mind } from "@volute/api";
import { Modal, TabBar } from "@volute/ui";
import Settings from "../../pages/Settings.svelte";
import SharedSkills from "../system/SharedSkills.svelte";
import SystemLogs from "../system/SystemLogs.svelte";
import UserManagement from "../system/UserManagement.svelte";

let { onClose, minds }: { onClose: () => void; minds: Mind[] } = $props();

const TABS = ["Settings", "Skills", "System Logs", "Users"] as const;
type Tab = (typeof TABS)[number];

let tab = $state<Tab>("Settings");
</script>

<Modal size="full" {onClose}>
  <div class="modal-header">
    <TabBar tabs={[...TABS]} active={tab} onchange={(t) => (tab = t as Tab)} />
    <button class="close-btn" onclick={onClose}>&#x2715;</button>
  </div>
  <div class="modal-body">
    {#if tab === "Settings"}
      <Settings />
    {:else if tab === "Skills"}
      <SharedSkills />
    {:else if tab === "System Logs"}
      <SystemLogs />
    {:else if tab === "Users"}
      <UserManagement {minds} />
    {/if}
  </div>
</Modal>

<style>
  .modal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    border-bottom: 1px solid var(--border);
    padding: 0 16px;
    flex-shrink: 0;
  }

  .close-btn {
    background: none;
    color: var(--text-2);
    font-size: 15px;
    padding: 4px 8px;
  }

  .close-btn:hover {
    color: var(--text-0);
  }

  .modal-body {
    flex: 1;
    overflow: auto;
    padding: 16px;
  }

  .files-container {
    height: 100%;
    margin: -16px;
  }
</style>
