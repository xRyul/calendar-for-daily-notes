# Problem
List view currently groups all daily-note entries under a single level: Year (YYYY). Users with nested daily note structures (e.g. year/month folders) want alternative grouping such as Year → Month → Day (e.g. `YYYY/MM` with day rows like `YYYY-MM-DD`) and potentially other grouping schemes.
# Current state (confirmed)
* Daily notes are sourced from `$dailyNotes` (via `getAllDailyNotes`) and turned into `ListItem[]` in `computeList()` (`src/ui/Calendar.svelte`), using `buildListItems()` (`src/ui/listViewModel.ts`).
* `computeList()` then groups `ListItem[]` by `item.year` only and renders `{#each listGroups as group}` where `group` is `YearGroup` (`src/ui/Calendar.svelte`).
* Open/closed UI state is tracked separately for year groups (`yearOpenState: Record<number, boolean>`) and for days (`dayOpenState: Record<string, boolean>`).
* List-view settings are edited inside the in-view menu (Svelte) via `writeOptions()` and stored in plugin settings (`ISettings` in `src/settings.ts`).
# Proposed changes
## 1) Add a list-view grouping preset setting
* Extend `ISettings` + `defaultSettings` with a new field, e.g. `listViewGroupingPreset: ListViewGroupingPreset`.
    * `ListViewGroupingPreset` is an enum/union of supported presets (no free-form formats).
    * Initial presets:
        * `year` — Year (YYYY) (current behavior)
        * `year_month` — Year → Month (YYYY/MM) (matches layouts like `YYYY/MM/YYYY-MM-DD`)
        * `year_month_name` — Year → Month Name (YYYY/MMMM) (e.g., `2025/December`)
        * `year_quarter` — Year → Quarter (YYYY/Q#) (e.g., `2025/Q1`)
        * `year_week` — ISO Year → ISO Week (GGGG/WW)
    * Fallback: unknown value → `year`.
* Update test helpers (`src/testUtils/settings.ts`) to include the new setting.
## 2) Build a nested group tree (not just YearGroup)
* Replace `YearGroup` with a generic recursive group model (e.g. `ListGroupNode`) in `src/ui/listViewModel.ts`:
    * `id: string` (stable path-like key, e.g. `2025/12`)
    * `label: string` (display label for the group header)
    * `groups: ListGroupNode[]` (children)
    * `items: ListItem[]` (only populated at leaf groups)
    * optional `maxEpoch` (internal) to sort groups by recency.
* Add a pure helper `buildListGroups(items, preset)` that:
    * Maps `preset` → grouping levels (internal formats/functions for id + label; not user-editable).
        * For `year_month_name`, keep `id` based on numeric month (`YYYY/MM`) but `label` as month name (`MMMM`) so locale changes don’t break open/closed state.
    * Builds a tree using Maps for O(n) grouping.
    * Sorts groups by recency (max descendant `epoch`) descending; keeps `items` already sorted by `epoch`.
## 3) Update list-view rendering to support arbitrary depth
* Introduce a small recursive Svelte component (e.g. `src/ui/ListGroup.svelte`) to render nested `<details>` groups.
    * Leaf groups expose `items` via a slot so existing day-row markup can remain in `Calendar.svelte`.
* Update `src/ui/Calendar.svelte`:
    * Replace `YearGroup[]` with the new group tree type.
    * Add a new open-state map `groupOpenState: Record<string, boolean>`.
    * Default open behavior: expand groups along “today’s” path for the selected preset; keep existing “preserve toggles across refreshes” behavior.
    * Ensure list recompute triggers when `$settings.listViewGroupingPreset` changes.
## 4) Add guided UI (preset dropdown)
* In the List view menu’s “List view” section (`src/ui/Calendar.svelte`), add a “Grouping” dropdown with the presets above (no custom input).
* Wire it to `writeOptions({ listViewGroupingPreset: ... })`.
## 5) Styling
* Generalize existing CSS selectors from “year” to “group” so nested groups look consistent:
    * Update selectors in `styles.css` (e.g. `.calendar-list-year` → `.calendar-list-group`).
    * Reuse the existing indentation container class (`.calendar-list-days`) for nested levels, so each depth naturally indents.
# Testing & validation
* Unit tests (Jest) for `buildListGroups()` in `src/ui/listViewModel.test.ts`:
    * `year` preset produces the same top-level grouping as today.
    * `year_month` nests month groups under year and assigns items to leaf groups.
    * `year_month_name` nests month groups under year and labels months using the active locale.
    * `year_quarter` nests quarter groups under year.
    * `year_week` groups weeks under ISO year.
    * Sorting: newest groups appear first.
* Manual validation in Obsidian:
    * Switch grouping presets while List view is open; verify stable open-state behavior and correct nesting.
    * Verify created-on-day placeholder days still appear under the correct group.
