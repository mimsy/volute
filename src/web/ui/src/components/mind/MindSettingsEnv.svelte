<script lang="ts">
import EnvVarList from "./EnvVarList.svelte";

let { name }: { name: string } = $props();
</script>

<EnvVarList {name} />
