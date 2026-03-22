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
import { formatCron } from "../lib/clock-format";

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

const HOURS = Array.from({ length: 24 }, (_, i) => i);
const MINUTES = [0, 15, 30, 45];

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

{#if error}
  <div class="error">{error}</div>
{/if}

<!-- Sleep -->
<div class="subsection">
  <div class="subsection-header">
    <span>Sleep</span>
    <label class="toggle">
      <input type="checkbox" checked={sleep?.enabled ?? false} onchange={toggleSleepEnabled} />
      <span>{sleep?.enabled ? "On" : "Off"}</span>
    </label>
  </div>

  {#if sleep?.enabled}
    {#if useCustomCron}
      <div class="sleep-summary">
        <span class="sleep-desc">Custom schedule</span>
        <button class="link-btn" onclick={() => { useCustomCron = false; saveSleepTime(); }}>Use time picker</button>
      </div>
      <div class="time-row">
        <span class="time-label">Sleep at</span>
        <input type="text" class="input cron-input" bind:value={editSleepCron} onblur={saveSleepTime} placeholder="0 0 * * *" />
      </div>
      {#if editSleepCron}
        <div class="cron-preview">{formatCron(editSleepCron)}</div>
      {/if}
      <div class="time-row">
        <span class="time-label">Wake at</span>
        <input type="text" class="input cron-input" bind:value={editWakeCron} onblur={saveSleepTime} placeholder="0 8 * * *" />
      </div>
      {#if editWakeCron}
        <div class="cron-preview">{formatCron(editWakeCron)}</div>
      {/if}
    {:else}
      <div class="sleep-summary">
        <span class="sleep-desc">Sleeps at {fmtTime(sleepHour, sleepMinute)}, wakes at {fmtTime(wakeHour, wakeMinute)}</span>
        <button class="link-btn" onclick={() => { useCustomCron = true; editSleepCron = timeToCron(sleepHour, sleepMinute); editWakeCron = timeToCron(wakeHour, wakeMinute); }}>Custom</button>
      </div>
      <div class="time-row">
        <span class="time-label">Sleep at</span>
        <select class="input time-select" bind:value={sleepHour} onchange={saveSleepTime}>
          {#each HOURS as h}<option value={h}>{fmtTime(h, 0).replace(/:\d+/, "")}</option>{/each}
        </select>
        <span class="time-sep">:</span>
        <select class="input time-select narrow" bind:value={sleepMinute} onchange={saveSleepTime}>
          {#each MINUTES as m}<option value={m}>{String(m).padStart(2, "0")}</option>{/each}
        </select>
      </div>
      <div class="time-row">
        <span class="time-label">Wake at</span>
        <select class="input time-select" bind:value={wakeHour} onchange={saveSleepTime}>
          {#each HOURS as h}<option value={h}>{fmtTime(h, 0).replace(/:\d+/, "")}</option>{/each}
        </select>
        <span class="time-sep">:</span>
        <select class="input time-select narrow" bind:value={wakeMinute} onchange={saveSleepTime}>
          {#each MINUTES as m}<option value={m}>{String(m).padStart(2, "0")}</option>{/each}
        </select>
      </div>
    {/if}

    <div class="wake-triggers">
      <div class="subsection-header small">What wakes the mind early</div>
      <div class="trigger-row">
        <label class="trigger-label">
          <input type="checkbox" checked={wakeOnMentions} onchange={() => { wakeOnMentions = !wakeOnMentions; saveWakeTriggers(); }} />
          When mentioned
        </label>
      </div>
      <div class="trigger-row">
        <label class="trigger-label">
          <input type="checkbox" checked={wakeOnDms} onchange={() => { wakeOnDms = !wakeOnDms; saveWakeTriggers(); }} />
          Direct messages
        </label>
      </div>
      <div class="trigger-row">
        <span class="trigger-text">Channels</span>
        <input
          type="text"
          class="input flex"
          bind:value={wakeChannels}
          placeholder="channel1, channel2"
          onblur={saveWakeTriggers}
        />
      </div>
      <div class="trigger-row">
        <span class="trigger-text">Senders</span>
        <input
          type="text"
          class="input flex"
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
    <button class="add-btn" onclick={() => (addingSchedule = true)}>Add</button>
  </div>

  {#if addingSchedule}
    <div class="schedule-form">
      <div class="form-row">
        <span class="form-label">Name</span>
        <input type="text" class="input flex" bind:value={newName} placeholder="e.g. heartbeat" />
      </div>
      <div class="form-row">
        <span class="form-label">Frequency</span>
        <select class="input" bind:value={newFreqType}>
          <option value="hours">Every few hours</option>
          <option value="daily">Daily at a time</option>
          <option value="cron">Custom cron</option>
        </select>
      </div>
      {#if newFreqType === "hours"}
        <div class="form-row">
          <span class="form-label"></span>
          <span class="form-hint">Every</span>
          <input type="number" class="input tiny" min="1" max="24" bind:value={newFreqHours} />
          <span class="form-hint">hours</span>
        </div>
      {:else if newFreqType === "daily"}
        <div class="form-row">
          <span class="form-label"></span>
          <span class="form-hint">At</span>
          <select class="input time-select" bind:value={newDailyHour}>
            {#each HOURS as h}<option value={h}>{fmtTime(h, 0).replace(/:\d+/, "")}</option>{/each}
          </select>
          <span class="time-sep">:</span>
          <select class="input time-select narrow" bind:value={newDailyMinute}>
            {#each MINUTES as m}<option value={m}>{String(m).padStart(2, "0")}</option>{/each}
          </select>
        </div>
      {:else}
        <div class="form-row">
          <span class="form-label"></span>
          <input type="text" class="input flex" bind:value={newCron} placeholder="*/30 * * * *" />
        </div>
      {/if}
      <div class="form-row">
        <span class="form-label">Message</span>
        <input type="text" class="input flex" bind:value={newMessage} placeholder="What to tell the mind" />
      </div>
      <div class="form-row">
        <span class="form-label">If sleeping</span>
        <select class="input" bind:value={newIfSleeping}>
          <option value="skip">Skip it</option>
          <option value="queue">Save for when awake</option>
          <option value="trigger-wake">Wake up for it</option>
        </select>
      </div>
      <div class="form-actions">
        <button class="save-btn" onclick={handleAddSchedule} disabled={saving !== null || !newName.trim()}>
          {saving === "sched:add" ? "..." : "Add schedule"}
        </button>
        <button class="cancel-btn" onclick={() => (addingSchedule = false)}>Cancel</button>
      </div>
    </div>
  {/if}

  {#if schedules.length === 0 && !addingSchedule}
    <div class="empty">No schedules configured.</div>
  {:else}
    <div class="schedule-list">
      {#each schedules as sched (sched.id)}
        {#if editingScheduleId === sched.id}
          <div class="schedule-card editing">
            <div class="form-row">
              <span class="form-label">Frequency</span>
              <select class="input" bind:value={editFreqType}>
                <option value="hours">Every few hours</option>
                <option value="daily">Daily at a time</option>
                <option value="cron">Custom cron</option>
              </select>
            </div>
            {#if editFreqType === "hours"}
              <div class="form-row">
                <span class="form-label"></span>
                <span class="form-hint">Every</span>
                <input type="number" class="input tiny" min="1" max="24" bind:value={editFreqHours} />
                <span class="form-hint">hours</span>
              </div>
            {:else if editFreqType === "daily"}
              <div class="form-row">
                <span class="form-label"></span>
                <span class="form-hint">At</span>
                <select class="input time-select" bind:value={editDailyHour}>
                  {#each HOURS as h}<option value={h}>{fmtTime(h, 0).replace(/:\d+/, "")}</option>{/each}
                </select>
                <span class="time-sep">:</span>
                <select class="input time-select narrow" bind:value={editDailyMinute}>
                  {#each MINUTES as m}<option value={m}>{String(m).padStart(2, "0")}</option>{/each}
                </select>
              </div>
            {:else}
              <div class="form-row">
                <span class="form-label"></span>
                <input type="text" class="input flex" bind:value={editCron} placeholder="*/30 * * * *" />
              </div>
            {/if}
            <div class="form-row">
              <span class="form-label">Message</span>
              <input type="text" class="input flex" bind:value={editMessage} placeholder="What to tell the mind" />
            </div>
            <div class="form-row">
              <span class="form-label">If sleeping</span>
              <select class="input" bind:value={editIfSleeping}>
                <option value="skip">Skip it</option>
                <option value="queue">Save for when awake</option>
                <option value="trigger-wake">Wake up for it</option>
              </select>
            </div>
            <div class="form-actions">
              <button class="save-btn" onclick={saveScheduleEdit} disabled={saving !== null}>
                {saving === `sched:${sched.id}` ? "..." : "Save"}
              </button>
              <button class="cancel-btn" onclick={() => (editingScheduleId = null)}>Cancel</button>
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
                <label class="toggle compact">
                  <input type="checkbox" checked={sched.enabled} onchange={() => toggleScheduleEnabled(sched)} />
                </label>
                <button class="icon-btn" onclick={() => startEditSchedule(sched)}>Edit</button>
                <button class="icon-btn danger" onclick={() => handleDeleteSchedule(sched.id)} disabled={saving !== null}>
                  {saving === `sched:${sched.id}` ? "..." : "Del"}
                </button>
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

  .empty {
    color: var(--text-2);
    padding: 12px;
    text-align: center;
    font-size: 14px;
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

  .link-btn {
    font-size: 11px;
    color: var(--text-2);
    background: none;
    border: none;
    cursor: pointer;
    text-decoration: underline;
    padding: 0;
  }

  .link-btn:hover {
    color: var(--text-1);
  }

  .time-row {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 0;
  }

  .time-label {
    font-size: 13px;
    color: var(--text-2);
    width: 60px;
    flex-shrink: 0;
  }

  .time-sep {
    font-size: 13px;
    color: var(--text-2);
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

  .trigger-label {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 13px;
    color: var(--text-1);
    cursor: pointer;
  }

  .trigger-label input[type="checkbox"] {
    accent-color: var(--accent);
  }

  .trigger-text {
    font-size: 13px;
    color: var(--text-1);
    width: 70px;
    flex-shrink: 0;
  }

  /* Inputs */
  .input {
    background: var(--bg-2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 4px 8px;
    font-size: 13px;
    font-family: inherit;
    color: var(--text-0);
  }

  .input:focus {
    border-color: var(--accent);
    outline: none;
  }

  .input.flex {
    flex: 1;
  }

  .input.tiny {
    width: 50px;
    flex: 0 0 50px;
    text-align: center;
  }

  .input.cron-input {
    flex: 1;
    font-family: var(--mono);
    font-size: 12px;
  }

  .time-select {
    width: auto;
  }

  .time-select.narrow {
    width: 55px;
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
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  /* Buttons */
  .save-btn {
    padding: 4px 12px;
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
    padding: 4px 12px;
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
