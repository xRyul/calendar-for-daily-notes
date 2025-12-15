# Problem statement
Add an optional “local Ollama” feature that generates more descriptive daily note labels for the Calendar list view, derived from the note’s content\.
Required label format: `YYYY-MM-DD - <3 words> - <1 short sentence>`\.
Also add a one\-click settings action to pull `gemma3:4b`\.
# Current state \(confirmed\)
* Calendar list view lives in `src/ui/Calendar.svelte` and currently renders each daily note button label as `item.dateStr` \(hard\-coded `YYYY-MM-DD`\) inside per\-year `<details>` groups\.
* The list is built from the `dailyNotes` Svelte store \(`src/ui/stores.ts`, backed by `obsidian-daily-notes-interface`\) and filtered by the existing `wordsPerDot` threshold; word count is computed from `app.vault.cachedRead(file)` and cached in\-memory by `file.path` \+ `mtime` \(`src/ui/Calendar.svelte`\)\.
* Plugin settings are defined in `src/settings.ts` \(`ISettings` \+ `defaultSettings`\) and persisted as a flat `ISettings` object via `loadData()/saveData()` in `src/main.ts`\.
* There is no existing Ollama client/integration code\.
# Proposed changes
## Settings \+ UX
* Extend `ISettings`/`defaultSettings` in `src/settings.ts` with an Ollama section:
    * `ollamaTitlesEnabled: boolean` \(default `false`\)
    * `ollamaBaseUrl: string` \(default `http://127.0.0.1:11434`\)
    * `ollamaModel: string` \(default `gemma3:4b`\)
    * `ollamaMaxChars: number` \(cap note text sent to model; default ~8k–12k chars\)
    * `ollamaRequestTimeoutMs: number` \(status/generate timeout; pull can be longer\)
    * `ollamaTitleCacheMaxEntries: number` \(default ~500–2000; bounds persisted cache size\)
* Add an “Ollama \(local\)” section in `CalendarSettingsTab.display()`:
    * Toggle: enable generated titles in list view \(shows generated titles \+ per\-note Generate button\)
    * Text: base URL
    * Text: model name
    * Button: “Pull Gemma 3 4B” \(one click\)
    * Button: “Clear generated titles” \(clears the cache\)
    * Read\-only status line updated asynchronously: server reachable \+ model installed\.
* Desktop/mobile behavior: show a clear “desktop only” message \(Obsidian mobile won’t have a local Ollama service\)\.
## Ollama client \(cross\-platform, no shelling out\)
* Add `src/ollama/client.ts` built on Obsidian’s `requestUrl` to call the local Ollama HTTP API at a user\-configured base URL\.
* Implement:
    * `getVersion()` via `GET /api/version` \(quick reachability check\)
    * `listModels()` via `GET /api/tags` \(detect whether `ollamaModel` and/or `gemma3:4b` is installed\)
    * `pullModel(model)` via `POST /api/pull` with `{ model, stream: false }` \(simple one\-click pull\)
    * `generateStructured(...)` via `POST /api/generate` with `{ stream: false, format: <json schema> }`
* Normalize user base URL so both `...:11434` and `...:11434/api` work \(strip trailing slashes and an optional `/api`\)\.
## Title generation \(deterministic \+ validated\)
* Add `src/ollama/title.ts`:
    * Prepare note input: strip YAML frontmatter, collapse whitespace, and truncate to `ollamaMaxChars`\.
    * Prompt for structured output only \(no extra text\) using a schema like:
        * `keywords: string[3]` \(exactly 3 words/phrases\)
        * `description: string` \(one short sentence\)
    * Validate/sanitize output:
        * Force `keywords.length === 3`, trim punctuation/newlines, join with single spaces\.
        * Ensure description is single\-line and short; truncate if needed\.
    * Compose label as `${dateStr} - ${keywords} - ${description}`\.
    * On any failure \(Ollama unreachable, model missing, invalid output\), fall back to `dateStr`\.
## Generated title storage \(no file renames\)
* Do not rename daily note files \(leave the daily note format unchanged\)\. Generated titles are stored separately and only affect the Calendar list view label\.
* Persist generated titles in plugin data so they survive restarts:
    * New saved\-data shape: `{ settings: ISettings, ollamaTitleCache: Record<string, { mtime: number, title: string, lastUsed?: number }> }`
    * Cache key: `file.path` \(simple and unambiguous\)\.
    * Migration: if existing saved data is the legacy “flat settings” object, treat it as `settings` and start with an empty cache\.
    * Eviction: keep at most `ollamaTitleCacheMaxEntries` entries \(delete least\-recently\-used or oldest\)\.
## Calendar list view integration \(manual per\-note generation\)
* Update `src/ui/Calendar.svelte` list items to retain enough file identity for summarisation \(store `filePath` and `mtime`, or store `TFile` directly\)\.
* Add a title cache read/write path:
    * Read cached title for `filePath` and only use it if `mtime` matches\.
    * Track in\-flight requests per `filePath` to dedupe clicks\.
    * On success, store `{ mtime, title }` in\-memory and persist it\.
* Rendering behavior per item:
    * Main button continues to open the daily note\.
    * If a cached title exists for current `mtime`, render it\.
    * Otherwise render `dateStr` and show a small “Generate” action button next to the item; clicking it runs summarisation for that note only and updates the label when complete\.
    * Disable the action button while in\-flight; show a subtle loading state; on error, show a single non\-spammy message and keep `dateStr`\.
* Add/adjust CSS in `styles.css` so long labels don’t blow out the layout \(e\.g\., single\-line ellipsis, and consistent alignment of the per\-item action button\)\.
## One\-click “Pull Gemma 3 4B”
* In settings, the button triggers `pullModel('gemma3:4b')` and shows feedback via `Notice` \+ refreshed status\.
* After pull success, re\-run `listModels()` and update the status line \(installed/not installed\)\.
# Testing
* Unit tests \(Jest\) for:
    * Base URL normalization and request building\.
    * Note preprocessing \+ structured\-output parsing/validation\.
    * Cache invalidation based on `mtime`\.
* Manual verification:
    * With Ollama running and `gemma3:4b` installed: open list view, expand year, click “Generate” on a note, verify title appears and is cached for unchanged `mtime`\.
    * Without Ollama / without model installed: verify “Generate” fails gracefully and settings status makes the problem obvious\.


