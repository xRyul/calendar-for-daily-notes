# Calendar (fork)

This repo is a fork of Liam Cain’s **Calendar** plugin for Obsidian.

## What’s different in this fork
- Adds a **List view** alongside the calendar for browsing daily notes in a compact, year-grouped list.
- Adds an optional **local Ollama** integration to generate nicer list labels from note content.

## Ollama-generated list titles (local)
When enabled, each daily note row in List view shows a small refresh icon to generate/update the title.

- Default model: `gemma3:4b`
- Uses your local Ollama server (default: `http://127.0.0.1:11434`)
- Generated titles are stored in plugin data (it **does not rename files**)

