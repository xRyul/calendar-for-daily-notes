<script lang="ts">
  import type { ListGroupNode } from "./listViewModel";

  export let node: ListGroupNode;
  export let openState: Record<string, boolean> = {};
  export let onToggle: (id: string, event: Event) => void = () => {};
</script>

<details
  class="calendar-list-group"
  open={openState[node.id]}
  on:toggle={(e) => onToggle(node.id, e)}
>
  <summary>
    <span class="calendar-chevron" aria-hidden="true">
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        width="16"
        height="16"
        fill="currentColor"
      >
        <path d="M8 5v14l11-7-11-7z"></path>
      </svg>
    </span>
    {node.label}
  </summary>

  <div class="calendar-list-days">
    {#if node.groups?.length}
      {#each node.groups as child (child.id)}
        <svelte:self node={child} {openState} {onToggle}>
          <svelte:fragment let:items>
            <slot {items} />
          </svelte:fragment>
        </svelte:self>
      {/each}
    {:else}
      <slot items={node.items} />
    {/if}
  </div>
</details>
