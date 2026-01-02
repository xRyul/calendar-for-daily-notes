# Daily Note Calendar
Calendar for daily notes with grouped lists, created-on-day notes and attachments, color tags, custom titles, and optional gemma3 title generation.
![Obsidian_NGf9Of9P0m](https://github.com/user-attachments/assets/2a644979-e9d7-40d7-983a-504801d79875)

### What’s different:
- **List view** - a new collapsible panel showing daily notes in a hierarchical tree with:

    <p align="center">
      <img width="350" alt="image" src="https://github.com/user-attachments/assets/46ff7a05-ddbc-40bb-9ebf-cea3e4357dac" />
    </p>

    - 6 grouping presets: Year, Year→Month, Year→Month Name, Year→Month #-Name, Year→Quarter, Year→Week
      <img width="990" alt="image" src="https://github.com/user-attachments/assets/2fbc06bc-a492-4667-8966-3ce20a006d29" />
      ![Obsidian_XMMou6lC47](https://github.com/user-attachments/assets/5d23e075-335d-4401-bb5b-79cfa16a3391)
    - Sorting: Newest→Oldest or Oldest→Newest
      ![Obsidian_hHJ9hfdC3a](https://github.com/user-attachments/assets/33ca1c6f-1b98-4183-bfbc-25e76a01a6e5)
    - Min word filter: Hide daily notes below a word count threshold
      ![Obsidian_XcieJKgR2Z](https://github.com/user-attachments/assets/a82d610f-b590-4f64-8876-3aa4d887befb)
    - Created-on-day items: Shows notes and attachments created on each day (by file creation time), even without a daily note
      ![Obsidian_urZIzTYEvg](https://github.com/user-attachments/assets/1d9c08c3-9772-497d-947d-e607412249ef)
    - Count badges: Optional display of daily note counts on group headers
      ![Obsidian_w7Twxgd2OF](https://github.com/user-attachments/assets/50d9e688-b464-4f22-9f22-dad628c2c057)
- Custom Titles for Daily Notes
    - Manually add/edit a custom title suffix per day (stored in plugin data, not file name)
      ![Obsidian_nc1OMYcjyp](https://github.com/user-attachments/assets/dba1ad35-2bb5-4734-91f0-9dc1ce9dda46)
    - Click the pencil icon on any day row to edit inline
- Color Tags
    - Right-click any day row or file to assign one of 8 colors (red, orange, yellow, green, blue, purple, pink, gray)
      ![Obsidian_4QPu8IIZ3y](https://github.com/user-attachments/assets/656836e7-086d-46ac-b2d5-f554672b7ea7)
    - Colors display as a subtle background highlight
- Adds an optional title generation via `gemma3:4b`
    - When enabled, each daily note row in List view shows a small refresh icon to generate/update the title. Gnerates 3 keywords + 1-sentence description from note content
    - Uses your local Ollama server (default: `http://127.0.0.1:11434`)
    - Cached by file mtime (regenerates only when content changes)
    - Generated titles are stored in plugin data (it **does not rename files**)
- UI Enhancements
    - Zoom controls: Separate zoom sliders for calendar (default 130%) and list view (default 95%)
    - Remember view state: Optional persistence of displayed month, list open/closed state, and expanded groups across restarts
    - Responsive scaling: Calendar auto-scales in narrow sidebars

## Network & privacy
- Title generation is optional, and sends note text only to your **local Ollama** server (`http://127.0.0.1:11434` by default).
- The plugin itself only talks to that local endpoint. When you click **Pull** (or generate titles without the model present), your Ollama server will download `gemma3:4b` from its configured registry (internet) just like `ollama pull gemma3:4b` on the CLI.
- Disable title generation in settings to avoid any Ollama requests.
- Generated titles are cached per file mtime; content isn’t re-sent unless the note changes.

## Credit

Fork of [Liam Cain’s **Calendar**](https://github.com/liamcain/obsidian-calendar-plugin) plugin for Obsidian.
