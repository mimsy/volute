<script lang="ts">
import EnvVarList from "../ui/EnvVarList.svelte";

let { name }: { name: string } = $props();
</script>

<EnvVarList {name} />
