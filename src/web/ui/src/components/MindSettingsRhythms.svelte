<script lang="ts">
import { onMount } from "svelte";
import {
  addSchedule,
  deleteSchedule,
  fetchSchedules,
  fetchSleepConfig,
  type ScheduleEntry,
  type SleepConfig,
  updateSchedule,
  updateSleepConfig,
} from "../lib/client";
import { formatCron, formatRelativeTime } from "../lib/clock-format";

let { name }: { name: string } = $props();

let sleep = $state<SleepConfig | null>(null);
let schedules = $state<ScheduleEntry[]>([]);
let error = $state("");
let loading = $state(true);

// Sleep edit states
let editSleepCron = $state("");
let editWakeCron = $state("");
let wakeOnMentions = $state(false);
let wakeOnDms = $state(false);
let wakeChannels = $state("");
let wakeSenders = $state("");

// Schedule add form
let addingSchedule = $state(false);
let newId = $state("");
let newCron = $state("");
let newMessage = $state("");
let newWhileSleeping = $state("skip");

// Inline edit
let editingScheduleId = $state<string | null>(null);
let editCron = $state("");
let editMessage = $state("");
let editWhileSleeping = $state("");
let editEnabled = $state(true);

let saving = $state<string | null>(null);

function syncSleepState(cfg: SleepConfig) {
  sleep = cfg;
  editSleepCron = cfg.schedule?.sleep ?? "";
  editWakeCron = cfg.schedule?.wake ?? "";
  wakeOnMentions = cfg.wakeTriggers?.mentions ?? false;
  wakeOnDms = cfg.wakeTriggers?.dms ?? false;
  wakeChannels = (cfg.wakeTriggers?.channels ?? []).join(", ");
  wakeSenders = (cfg.wakeTriggers?.senders ?? []).join(", ");
}

async function refresh() {
  try {
    const [cfg, sched] = await Promise.all([fetchSleepConfig(name), fetchSchedules(name)]);
    syncSleepState(cfg);
    schedules = sched;
    error = "";
  } catch {
    error = "Failed to load configuration";
  }
  loading = false;
}

onMount(() => {
  refresh();
});

async function toggleSleepEnabled() {
  if (!sleep) return;
  const enabled = !sleep.enabled;
  saving = "sleep-toggle";
  try {
    await updateSleepConfig(name, { enabled });
    sleep = { ...sleep, enabled };
    error = "";
  } catch (e) {
    error = e instanceof Error ? e.message : "Failed to update";
  }
  saving = null;
}

async function saveSleepSchedule() {
  saving = "sleep-cron";
  try {
    await updateSleepConfig(name, {
      schedule: { sleep: editSleepCron, wake: editWakeCron },
    });
    if (sleep) {
      sleep = { ...sleep, schedule: { sleep: editSleepCron, wake: editWakeCron } };
    }
    error = "";
  } catch (e) {
    error = e instanceof Error ? e.message : "Failed to update";
  }
  saving = null;
}

async function saveWakeTriggers() {
  saving = "wake-triggers";
  try {
    const channels = wakeChannels
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const senders = wakeSenders
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    await updateSleepConfig(name, {
      wakeTriggers: {
        mentions: wakeOnMentions,
        dms: wakeOnDms,
        channels: channels.length ? channels : undefined,
        senders: senders.length ? senders : undefined,
      },
    });
    if (sleep) {
      sleep = {
        ...sleep,
        wakeTriggers: { mentions: wakeOnMentions, dms: wakeOnDms, channels, senders },
      };
    }
    error = "";
  } catch (e) {
    error = e instanceof Error ? e.message : "Failed to update";
  }
  saving = null;
}

async function toggleScheduleEnabled(sched: ScheduleEntry) {
  saving = `sched:${sched.id}`;
  try {
    await updateSchedule(name, sched.id, { enabled: !sched.enabled });
    schedules = schedules.map((s) => (s.id === sched.id ? { ...s, enabled: !s.enabled } : s));
    error = "";
  } catch (e) {
    error = e instanceof Error ? e.message : "Failed to update";
  }
  saving = null;
}

function startEditSchedule(sched: ScheduleEntry) {
  editingScheduleId = sched.id;
  editCron = sched.cron ?? "";
  editMessage = sched.message ?? sched.script ?? "";
  editWhileSleeping = sched.whileSleeping ?? "skip";
  editEnabled = sched.enabled;
}

async function saveScheduleEdit() {
  if (!editingScheduleId) return;
  saving = `sched:${editingScheduleId}`;
  try {
    await updateSchedule(name, editingScheduleId, {
      cron: editCron || undefined,
      message: editMessage || undefined,
      whileSleeping: editWhileSleeping,
      enabled: editEnabled,
    });
    schedules = schedules.map((s) =>
      s.id === editingScheduleId
        ? {
            ...s,
            cron: editCron || undefined,
            message: editMessage || undefined,
            whileSleeping: editWhileSleeping,
            enabled: editEnabled,
          }
        : s,
    );
    editingScheduleId = null;
    error = "";
  } catch (e) {
    error = e instanceof Error ? e.message : "Failed to save";
  }
  saving = null;
}

async function handleAddSchedule() {
  if (!newId.trim()) return;
  saving = "sched:add";
  try {
    await addSchedule(name, {
      id: newId.trim(),
      cron: newCron || undefined,
      message: newMessage || undefined,
      whileSleeping: newWhileSleeping,
      enabled: true,
    });
    schedules = await fetchSchedules(name);
    newId = "";
    newCron = "";
    newMessage = "";
    newWhileSleeping = "skip";
    addingSchedule = false;
    error = "";
  } catch (e) {
    error = e instanceof Error ? e.message : "Failed to add";
  }
  saving = null;
}

async function handleDeleteSchedule(id: string) {
  saving = `sched:${id}`;
  try {
    await deleteSchedule(name, id);
    schedules = schedules.filter((s) => s.id !== id);
    error = "";
  } catch (e) {
    error = e instanceof Error ? e.message : "Failed to delete";
  }
  saving = null;
}

function handleKeydown(e: KeyboardEvent, action: () => void) {
  if (e.key === "Enter") action();
}
</script>

{#if error}
  <div class="error">{error}</div>
{/if}

<!-- Sleep -->
<div class="subsection">
  <div class="subsection-header">
    Sleep
    <label class="toggle">
      <input type="checkbox" checked={sleep?.enabled ?? false} onchange={toggleSleepEnabled} />
      <span>{sleep?.enabled ? "On" : "Off"}</span>
    </label>
  </div>
  {#if sleep?.enabled}
    <div class="field-group">
      <div class="field-row">
        <span class="field-label">Sleep</span>
        <input
          type="text"
          class="input"
          bind:value={editSleepCron}
          placeholder="0 23 * * *"
          onblur={saveSleepSchedule}
          onkeydown={(e) => handleKeydown(e, saveSleepSchedule)}
        />
      </div>
      {#if editSleepCron}
        <div class="cron-preview">{formatCron(editSleepCron)}</div>
      {/if}
      <div class="field-row">
        <span class="field-label">Wake</span>
        <input
          type="text"
          class="input"
          bind:value={editWakeCron}
          placeholder="0 7 * * *"
          onblur={saveSleepSchedule}
          onkeydown={(e) => handleKeydown(e, saveSleepSchedule)}
        />
      </div>
      {#if editWakeCron}
        <div class="cron-preview">{formatCron(editWakeCron)}</div>
      {/if}
    </div>

    <div class="wake-triggers">
      <div class="subsection-header small">Wake triggers</div>
      <div class="trigger-row">
        <span class="trigger-label">Mentions</span>
        <input type="checkbox" checked={wakeOnMentions} onchange={() => { wakeOnMentions = !wakeOnMentions; saveWakeTriggers(); }} />
      </div>
      <div class="trigger-row">
        <span class="trigger-label">DMs</span>
        <input type="checkbox" checked={wakeOnDms} onchange={() => { wakeOnDms = !wakeOnDms; saveWakeTriggers(); }} />
      </div>
      <div class="trigger-row">
        <span class="trigger-label">Channels</span>
        <input
          type="text"
          class="input flex"
          bind:value={wakeChannels}
          placeholder="channel1, channel2"
          onblur={saveWakeTriggers}
          onkeydown={(e) => handleKeydown(e, saveWakeTriggers)}
        />
      </div>
      <div class="trigger-row">
        <span class="trigger-label">Senders</span>
        <input
          type="text"
          class="input flex"
          bind:value={wakeSenders}
          placeholder="user1, user2"
          onblur={saveWakeTriggers}
          onkeydown={(e) => handleKeydown(e, saveWakeTriggers)}
        />
      </div>
    </div>
  {/if}
</div>

<!-- Schedules -->
<div class="subsection">
  <div class="subsection-header">
    Schedules
    <button class="add-btn" onclick={() => (addingSchedule = true)}>Add</button>
  </div>

  {#if addingSchedule}
    <div class="schedule-add-row">
      <input
        type="text"
        class="input id"
        bind:value={newId}
        placeholder="id"
        onkeydown={(e) => handleKeydown(e, handleAddSchedule)}
      />
      <input
        type="text"
        class="input cron"
        bind:value={newCron}
        placeholder="cron"
        onkeydown={(e) => handleKeydown(e, handleAddSchedule)}
      />
      <input
        type="text"
        class="input message"
        bind:value={newMessage}
        placeholder="message"
        onkeydown={(e) => handleKeydown(e, handleAddSchedule)}
      />
      <select class="input select" bind:value={newWhileSleeping}>
        <option value="skip">skip</option>
        <option value="queue">queue</option>
        <option value="trigger-wake">trigger-wake</option>
      </select>
      <button class="save-btn" onclick={handleAddSchedule} disabled={saving !== null}>
        {saving === "sched:add" ? "..." : "Add"}
      </button>
      <button class="cancel-btn" onclick={() => (addingSchedule = false)}>Cancel</button>
    </div>
  {/if}

  {#if schedules.length === 0 && !addingSchedule}
    <div class="empty small">No schedules configured.</div>
  {:else}
    <div class="schedule-list">
      {#each schedules as sched (sched.id)}
        <div class="schedule-row">
          {#if editingScheduleId === sched.id}
            <span class="schedule-name">{sched.id}</span>
            <input
              type="text"
              class="input cron"
              bind:value={editCron}
              placeholder="cron"
              onkeydown={(e) => handleKeydown(e, saveScheduleEdit)}
            />
            <input
              type="text"
              class="input message"
              bind:value={editMessage}
              placeholder="message"
              onkeydown={(e) => handleKeydown(e, saveScheduleEdit)}
            />
            <select class="input select" bind:value={editWhileSleeping}>
              <option value="skip">skip</option>
              <option value="queue">queue</option>
              <option value="trigger-wake">trigger-wake</option>
            </select>
            <button class="save-btn" onclick={saveScheduleEdit} disabled={saving !== null}>
              {saving === `sched:${sched.id}` ? "..." : "Save"}
            </button>
            <button class="cancel-btn" onclick={() => (editingScheduleId = null)}>Cancel</button>
          {:else}
            <span class="schedule-name">{sched.id}</span>
            <span class="schedule-cron">
              {#if sched.cron}
                {formatCron(sched.cron)}
              {:else if sched.fireAt}
                {formatRelativeTime(sched.fireAt)}
              {:else}
                --
              {/if}
            </span>
            <span class="schedule-message">{sched.message ?? sched.script ?? ""}</span>
            <label class="toggle compact">
              <input
                type="checkbox"
                checked={sched.enabled}
                onchange={() => toggleScheduleEnabled(sched)}
              />
            </label>
            <button class="icon-btn" onclick={() => startEditSchedule(sched)}>Edit</button>
            <button
              class="icon-btn danger"
              onclick={() => handleDeleteSchedule(sched.id)}
              disabled={saving !== null}
            >
              {saving === `sched:${sched.id}` ? "..." : "Del"}
            </button>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .subsection {
    margin-bottom: 20px;
  }

  .subsection-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: 13px;
    font-weight: 600;
    color: var(--text-1);
    margin-bottom: 8px;
  }

  .subsection-header.small {
    font-size: 12px;
    font-weight: 500;
    color: var(--text-2);
    margin-top: 12px;
  }

  .toggle {
    display: flex;
    align-items: center;
    gap: 6px;
    font-weight: 400;
    cursor: pointer;
  }

  .toggle input[type="checkbox"] {
    accent-color: var(--accent);
  }

  .toggle.compact {
    gap: 0;
  }

  .error {
    color: var(--red);
    font-size: 13px;
    margin-bottom: 8px;
  }

  .empty.small {
    color: var(--text-2);
    padding: 12px;
    text-align: center;
    font-size: 14px;
  }

  .field-group {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-bottom: 8px;
  }

  .field-row {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .field-label {
    font-size: 13px;
    color: var(--text-1);
    width: 50px;
    flex-shrink: 0;
  }

  .cron-preview {
    font-size: 11px;
    color: var(--text-2);
    margin-top: 2px;
    margin-left: 58px;
    margin-bottom: 4px;
  }

  .wake-triggers {
    margin-top: 8px;
  }

  .trigger-row {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 4px 0;
  }

  .trigger-label {
    font-size: 13px;
    color: var(--text-1);
    width: 80px;
  }

  .trigger-row input[type="checkbox"] {
    accent-color: var(--accent);
  }

  .input {
    background: var(--bg-2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 4px 8px;
    font-size: 13px;
    font-family: inherit;
    color: var(--text-0);
  }

  .input.flex {
    flex: 1;
  }

  .input.id {
    width: 80px;
    flex-shrink: 0;
  }

  .input.cron {
    width: 120px;
    flex-shrink: 0;
  }

  .input.message {
    flex: 1;
  }

  .input.select {
    width: 110px;
    flex-shrink: 0;
  }

  .schedule-list {
    display: flex;
    flex-direction: column;
  }

  .schedule-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 0;
    border-bottom: 1px solid var(--border);
    font-size: 13px;
  }

  .schedule-row:last-child {
    border-bottom: none;
  }

  .schedule-add-row {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 0;
    margin-bottom: 8px;
  }

  .schedule-name {
    font-weight: 500;
    color: var(--text-0);
    min-width: 80px;
  }

  .schedule-cron {
    color: var(--text-2);
    flex: 1;
  }

  .schedule-message {
    color: var(--text-2);
    flex: 2;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .save-btn {
    padding: 4px 10px;
    font-size: 12px;
    border-radius: var(--radius);
    background: var(--accent-dim);
    color: var(--accent);
    font-weight: 500;
    flex-shrink: 0;
  }

  .save-btn:disabled {
    opacity: 0.5;
  }

  .cancel-btn {
    padding: 4px 10px;
    font-size: 12px;
    border-radius: var(--radius);
    background: var(--bg-3);
    color: var(--text-2);
    font-weight: 500;
    flex-shrink: 0;
  }

  .add-btn {
    padding: 4px 12px;
    font-size: 12px;
    border-radius: var(--radius);
    background: var(--accent-dim);
    color: var(--accent);
    font-weight: 500;
  }

  .icon-btn {
    padding: 2px 6px;
    font-size: 11px;
    border-radius: var(--radius);
    background: var(--bg-3);
    color: var(--text-2);
    flex-shrink: 0;
  }

  .icon-btn:hover {
    color: var(--text-0);
  }

  .icon-btn.danger:hover {
    color: var(--red);
  }
</style>
