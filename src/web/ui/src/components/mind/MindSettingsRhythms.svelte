<script lang="ts">
import { Button, EmptyState, ErrorMessage, Input, Select, TimePicker, Toggle } from "@volute/ui";
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
} from "../../lib/client";
import { formatCron } from "../../lib/clock-format";

let { name }: { name: string } = $props();

let sleep = $state<SleepConfig | null>(null);
let schedules = $state<ScheduleEntry[]>([]);
let error = $state("");
let loading = $state(true);

// Sleep edit states
let sleepHour = $state(0);
let sleepMinute = $state(0);
let wakeHour = $state(8);
let wakeMinute = $state(0);
let useCustomCron = $state(false);
let editSleepCron = $state("");
let editWakeCron = $state("");
let wakeOnMentions = $state(false);
let wakeOnDms = $state(false);
let wakeChannels = $state("");
let wakeSenders = $state("");

// Schedule add form
let addingSchedule = $state(false);
let newName = $state("");
let newFreqType = $state<"hours" | "daily" | "cron">("daily");
let newFreqHours = $state(4);
let newDailyHour = $state(12);
let newDailyMinute = $state(0);
let newCron = $state("");
let newMessage = $state("");
let newIfSleeping = $state("skip");

// Inline edit
let editingScheduleId = $state<string | null>(null);
let editFreqType = $state<"hours" | "daily" | "cron">("cron");
let editFreqHours = $state(4);
let editDailyHour = $state(12);
let editDailyMinute = $state(0);
let editCron = $state("");
let editMessage = $state("");
let editIfSleeping = $state("skip");
let editEnabled = $state(true);

let saving = $state<string | null>(null);

function fmtTime(h: number, m: number): string {
  const suffix = h >= 12 ? "pm" : "am";
  const h12 = h % 12 || 12;
  return m === 0 ? `${h12}${suffix}` : `${h12}:${String(m).padStart(2, "0")}${suffix}`;
}

function parseCronToTime(cron: string): { hour: number; minute: number } | null {
  const parts = cron.split(" ");
  if (parts.length < 5) return null;
  const [min, hour, dom, , dow] = parts;
  if (/^\d+$/.test(min) && /^\d+$/.test(hour) && dom === "*" && dow === "*") {
    return { hour: +hour, minute: +min };
  }
  return null;
}

function timeToCron(hour: number, minute: number): string {
  return `${minute} ${hour} * * *`;
}

/** Parse a cron into a frequency type for schedule editing */
function parseCronToFreq(cron: string): {
  type: "hours" | "daily" | "cron";
  hours?: number;
  hour?: number;
  minute?: number;
} {
  const parts = cron.split(" ");
  if (parts.length < 5) return { type: "cron" };
  const [min, hour, dom, mon, dow] = parts;
  // Every N minutes → convert to hours if clean
  if (min.startsWith("*/") && hour === "*" && dom === "*" && mon === "*" && dow === "*") {
    const n = +min.slice(2);
    if (n >= 60 && n % 60 === 0) return { type: "hours", hours: n / 60 };
  }
  // Every N hours
  if (/^\d+$/.test(min) && hour.startsWith("*/") && dom === "*" && mon === "*" && dow === "*") {
    return { type: "hours", hours: +hour.slice(2) };
  }
  // Daily at specific time(s)
  if (/^\d+$/.test(min) && /^\d+$/.test(hour) && dom === "*" && mon === "*" && dow === "*") {
    return { type: "daily", hour: +hour, minute: +min };
  }
  // Multi-hour daily (e.g. "0 8,12,16 * * *")
  if (/^\d+$/.test(min) && /^[\d,]+$/.test(hour) && dom === "*" && mon === "*" && dow === "*") {
    const hours = hour.split(",").map(Number);
    if (hours.length > 1) {
      const gap = hours[1] - hours[0];
      if (hours.every((h, i) => i === 0 || h - hours[i - 1] === gap)) {
        return { type: "hours", hours: gap };
      }
    }
    return { type: "daily", hour: hours[0], minute: +min };
  }
  return { type: "cron" };
}

function freqToCron(
  type: "hours" | "daily" | "cron",
  opts: { hours?: number; hour?: number; minute?: number; cron?: string },
): string {
  if (type === "hours") return `0 */${opts.hours ?? 4} * * *`;
  if (type === "daily") return `${opts.minute ?? 0} ${opts.hour ?? 12} * * *`;
  return opts.cron ?? "";
}

function syncSleepState(cfg: SleepConfig) {
  sleep = cfg;
  editSleepCron = cfg.schedule?.sleep ?? "";
  editWakeCron = cfg.schedule?.wake ?? "";
  const sleepTime = parseCronToTime(editSleepCron);
  const wakeTime = parseCronToTime(editWakeCron);
  if (sleepTime && wakeTime) {
    sleepHour = sleepTime.hour;
    sleepMinute = sleepTime.minute;
    wakeHour = wakeTime.hour;
    wakeMinute = wakeTime.minute;
    useCustomCron = false;
  } else if (editSleepCron || editWakeCron) {
    useCustomCron = true;
  }
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

async function saveSleepTime() {
  const sleepCron = useCustomCron ? editSleepCron : timeToCron(sleepHour, sleepMinute);
  const wakeCron = useCustomCron ? editWakeCron : timeToCron(wakeHour, wakeMinute);
  saving = "sleep-cron";
  try {
    await updateSleepConfig(name, { schedule: { sleep: sleepCron, wake: wakeCron } });
    if (sleep) {
      sleep = { ...sleep, schedule: { sleep: sleepCron, wake: wakeCron } };
    }
    editSleepCron = sleepCron;
    editWakeCron = wakeCron;
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
  const freq = sched.cron ? parseCronToFreq(sched.cron) : { type: "daily" as const };
  editFreqType = freq.type;
  editFreqHours = freq.hours ?? 4;
  editDailyHour = freq.hour ?? 12;
  editDailyMinute = freq.minute ?? 0;
  editCron = sched.cron ?? "";
  editMessage = sched.message ?? sched.script ?? "";
  editIfSleeping = sched.whileSleeping ?? "skip";
  editEnabled = sched.enabled;
}

async function saveScheduleEdit() {
  if (!editingScheduleId) return;
  const cron = freqToCron(editFreqType, {
    hours: editFreqHours,
    hour: editDailyHour,
    minute: editDailyMinute,
    cron: editCron,
  });
  saving = `sched:${editingScheduleId}`;
  try {
    await updateSchedule(name, editingScheduleId, {
      cron: cron || undefined,
      message: editMessage || undefined,
      whileSleeping: editIfSleeping,
      enabled: editEnabled,
    });
    schedules = schedules.map((s) =>
      s.id === editingScheduleId
        ? {
            ...s,
            cron,
            message: editMessage || undefined,
            whileSleeping: editIfSleeping,
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
  if (!newName.trim()) return;
  const cron = freqToCron(newFreqType, {
    hours: newFreqHours,
    hour: newDailyHour,
    minute: newDailyMinute,
    cron: newCron,
  });
  saving = "sched:add";
  try {
    await addSchedule(name, {
      id: newName.trim(),
      cron: cron || undefined,
      message: newMessage || undefined,
      whileSleeping: newIfSleeping,
      enabled: true,
    });
    schedules = await fetchSchedules(name);
    newName = "";
    newFreqType = "daily";
    newFreqHours = 4;
    newDailyHour = 12;
    newDailyMinute = 0;
    newCron = "";
    newMessage = "";
    newIfSleeping = "skip";
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
</script>

<ErrorMessage message={error} />

<!-- Sleep -->
<div class="subsection">
  <div class="subsection-header">
    <span>Sleep</span>
    <Toggle checked={sleep?.enabled ?? false} onchange={toggleSleepEnabled} label={sleep?.enabled ? "On" : "Off"} />
  </div>

  {#if sleep?.enabled}
    {#if useCustomCron}
      <div class="sleep-summary">
        <span class="sleep-desc">Custom schedule</span>
        <Button variant="text" size="sm" onclick={() => { useCustomCron = false; saveSleepTime(); }}>Use time picker</Button>
      </div>
      <div class="cron-row">
        <span class="cron-label">Sleep at</span>
        <Input variant="mono" style="flex:1" bind:value={editSleepCron} onblur={saveSleepTime} placeholder="0 0 * * *" />
      </div>
      {#if editSleepCron}
        <div class="cron-preview">{formatCron(editSleepCron)}</div>
      {/if}
      <div class="cron-row">
        <span class="cron-label">Wake at</span>
        <Input variant="mono" style="flex:1" bind:value={editWakeCron} onblur={saveSleepTime} placeholder="0 8 * * *" />
      </div>
      {#if editWakeCron}
        <div class="cron-preview">{formatCron(editWakeCron)}</div>
      {/if}
    {:else}
      <div class="sleep-summary">
        <span class="sleep-desc">Sleeps at {fmtTime(sleepHour, sleepMinute)}, wakes at {fmtTime(wakeHour, wakeMinute)}</span>
        <Button variant="text" size="sm" onclick={() => { useCustomCron = true; editSleepCron = timeToCron(sleepHour, sleepMinute); editWakeCron = timeToCron(wakeHour, wakeMinute); }}>Custom</Button>
      </div>
      <TimePicker label="Sleep at" bind:hour={sleepHour} bind:minute={sleepMinute} onchange={saveSleepTime} />
      <TimePicker label="Wake at" bind:hour={wakeHour} bind:minute={wakeMinute} onchange={saveSleepTime} />
    {/if}

    <div class="wake-triggers">
      <div class="subsection-header small">What wakes the mind early</div>
      <div class="trigger-row">
        <Toggle checked={wakeOnMentions} onchange={() => { wakeOnMentions = !wakeOnMentions; saveWakeTriggers(); }} label="When mentioned" />
      </div>
      <div class="trigger-row">
        <Toggle checked={wakeOnDms} onchange={() => { wakeOnDms = !wakeOnDms; saveWakeTriggers(); }} label="Direct messages" />
      </div>
      <div class="trigger-row">
        <span class="trigger-text">Channels</span>
        <Input
          type="text"
          style="flex:1"
          bind:value={wakeChannels}
          placeholder="channel1, channel2"
          onblur={saveWakeTriggers}
        />
      </div>
      <div class="trigger-row">
        <span class="trigger-text">Senders</span>
        <Input
          type="text"
          style="flex:1"
          bind:value={wakeSenders}
          placeholder="user1, user2"
          onblur={saveWakeTriggers}
        />
      </div>
    </div>
  {/if}
</div>

<!-- Schedules -->
<div class="subsection">
  <div class="subsection-header">
    <span>Schedules</span>
    <Button variant="primary" onclick={() => (addingSchedule = true)}>Add</Button>
  </div>

  {#if addingSchedule}
    <div class="schedule-form">
      <div class="form-row">
        <span class="form-label">Name</span>
        <Input type="text" style="flex:1" bind:value={newName} placeholder="e.g. heartbeat" />
      </div>
      <div class="form-row">
        <span class="form-label">Frequency</span>
        <Select bind:value={newFreqType}>
          <option value="hours">Every few hours</option>
          <option value="daily">Daily at a time</option>
          <option value="cron">Custom cron</option>
        </Select>
      </div>
      {#if newFreqType === "hours"}
        <div class="form-row">
          <span class="form-label"></span>
          <span class="form-hint">Every</span>
          <Input type="number" width="50px" style="text-align:center" min="1" max="24" bind:value={newFreqHours} />
          <span class="form-hint">hours</span>
        </div>
      {:else if newFreqType === "daily"}
        <div class="form-row">
          <span class="form-label"></span>
          <span class="form-hint">At</span>
          <TimePicker bind:hour={newDailyHour} bind:minute={newDailyMinute} />
        </div>
      {:else}
        <div class="form-row">
          <span class="form-label"></span>
          <Input type="text" style="flex:1" bind:value={newCron} placeholder="*/30 * * * *" />
        </div>
      {/if}
      <div class="form-row">
        <span class="form-label">Message</span>
        <Input type="text" style="flex:1" bind:value={newMessage} placeholder="What to tell the mind" />
      </div>
      <div class="form-row">
        <span class="form-label">If sleeping</span>
        <Select bind:value={newIfSleeping}>
          <option value="skip">Skip it</option>
          <option value="queue">Save for when awake</option>
          <option value="trigger-wake">Wake up for it</option>
        </Select>
      </div>
      <div class="form-actions">
        <Button variant="primary" onclick={handleAddSchedule} disabled={saving !== null || !newName.trim()}>
          {saving === "sched:add" ? "..." : "Add schedule"}
        </Button>
        <Button variant="secondary" onclick={() => (addingSchedule = false)}>Cancel</Button>
      </div>
    </div>
  {/if}

  {#if schedules.length === 0 && !addingSchedule}
    <EmptyState message="No schedules configured." />
  {:else}
    <div class="schedule-list">
      {#each schedules as sched (sched.id)}
        {#if editingScheduleId === sched.id}
          <div class="schedule-card editing">
            <div class="form-row">
              <span class="form-label">Frequency</span>
              <Select bind:value={editFreqType}>
                <option value="hours">Every few hours</option>
                <option value="daily">Daily at a time</option>
                <option value="cron">Custom cron</option>
              </Select>
            </div>
            {#if editFreqType === "hours"}
              <div class="form-row">
                <span class="form-label"></span>
                <span class="form-hint">Every</span>
                <Input type="number" width="50px" style="text-align:center" min="1" max="24" bind:value={editFreqHours} />
                <span class="form-hint">hours</span>
              </div>
            {:else if editFreqType === "daily"}
              <div class="form-row">
                <span class="form-label"></span>
                <span class="form-hint">At</span>
                <TimePicker bind:hour={editDailyHour} bind:minute={editDailyMinute} />
              </div>
            {:else}
              <div class="form-row">
                <span class="form-label"></span>
                <Input type="text" style="flex:1" bind:value={editCron} placeholder="*/30 * * * *" />
              </div>
            {/if}
            <div class="form-row">
              <span class="form-label">Message</span>
              <Input type="text" style="flex:1" bind:value={editMessage} placeholder="What to tell the mind" />
            </div>
            <div class="form-row">
              <span class="form-label">If sleeping</span>
              <Select bind:value={editIfSleeping}>
                <option value="skip">Skip it</option>
                <option value="queue">Save for when awake</option>
                <option value="trigger-wake">Wake up for it</option>
              </Select>
            </div>
            <div class="form-actions">
              <Button variant="primary" onclick={saveScheduleEdit} disabled={saving !== null}>
                {saving === `sched:${sched.id}` ? "..." : "Save"}
              </Button>
              <Button variant="secondary" onclick={() => (editingScheduleId = null)}>Cancel</Button>
            </div>
          </div>
        {:else}
          <div class="schedule-card" class:disabled={!sched.enabled}>
            <div class="schedule-top">
              <span class="schedule-name">{sched.id}</span>
              <span class="schedule-freq">
                {#if sched.cron}
                  {formatCron(sched.cron)}
                {:else if sched.fireAt}
                  one-time
                {:else}
                  --
                {/if}
              </span>
              <div class="schedule-actions">
                <Toggle checked={sched.enabled} onchange={() => toggleScheduleEnabled(sched)} />
                <Button variant="icon" onclick={() => startEditSchedule(sched)}>Edit</Button>
                <Button variant="danger" size="sm" class="icon-size" onclick={() => handleDeleteSchedule(sched.id)} disabled={saving !== null}>
                  {saving === `sched:${sched.id}` ? "..." : "Del"}
                </Button>
              </div>
            </div>
            {#if sched.message}
              <div class="schedule-message">{sched.message}</div>
            {/if}
          </div>
        {/if}
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

  /* Sleep */
  .sleep-summary {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 10px;
  }

  .sleep-desc {
    font-size: 13px;
    color: var(--text-1);
  }

  .cron-row {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 0;
  }

  .cron-label {
    font-size: 13px;
    color: var(--text-2);
    width: 60px;
    flex-shrink: 0;
  }

  .cron-preview {
    font-size: 11px;
    color: var(--text-2);
    margin-left: 66px;
    margin-bottom: 4px;
  }

  /* Wake triggers */
  .wake-triggers {
    margin-top: 8px;
  }

  .trigger-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 3px 0;
  }

  .trigger-text {
    font-size: 13px;
    color: var(--text-1);
    width: 70px;
    flex-shrink: 0;
  }

  /* Schedule form */
  .schedule-form {
    background: var(--bg-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg, 8px);
    padding: 12px;
    margin-bottom: 12px;
  }

  .form-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 3px 0;
  }

  .form-label {
    font-size: 13px;
    color: var(--text-2);
    width: 70px;
    flex-shrink: 0;
  }

  .form-hint {
    font-size: 13px;
    color: var(--text-2);
    flex-shrink: 0;
  }

  .form-actions {
    display: flex;
    gap: 6px;
    margin-top: 8px;
    padding-top: 8px;
    border-top: 1px solid var(--border);
  }

  /* Schedule list */
  .schedule-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .schedule-card {
    border: 1px solid var(--border);
    border-radius: var(--radius-lg, 8px);
    padding: 10px 12px;
  }

  .schedule-card.disabled {
    opacity: 0.5;
  }

  .schedule-card.editing {
    background: var(--bg-2);
    padding: 12px;
  }

  .schedule-top {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .schedule-name {
    font-weight: 500;
    font-size: 13px;
    color: var(--text-0);
  }

  .schedule-freq {
    flex: 1;
    font-size: 12px;
    color: var(--text-2);
  }

  .schedule-actions {
    display: flex;
    align-items: center;
    gap: 4px;
    flex-shrink: 0;
  }

  .schedule-message {
    font-size: 12px;
    color: var(--text-2);
    margin-top: 4px;
    line-height: 1.4;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  :global(.icon-size) {
    padding: 2px 6px !important;
    font-size: 11px !important;
  }
</style>
