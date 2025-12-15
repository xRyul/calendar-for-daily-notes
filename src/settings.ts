import {
  App,
  Notice,
  Platform,
  PluginSettingTab,
  Setting,
  type ButtonComponent,
} from "obsidian";
import { appHasDailyNotesPluginLoaded } from "obsidian-daily-notes-interface";
import type { ILocaleOverride, IWeekStartOption } from "obsidian-calendar-ui";

import { DEFAULT_WEEK_FORMAT, DEFAULT_WORDS_PER_DOT } from "src/constants";

import { createOllamaClient, isModelInstalled } from "src/ollama/client";

import type CalendarPlugin from "./main";

export interface ISettings {
  wordsPerDot: number;
  weekStart: IWeekStartOption;
  shouldConfirmBeforeCreate: boolean;

  // Weekly Note settings
  showWeeklyNote: boolean;
  weeklyNoteFormat: string;
  weeklyNoteTemplate: string;
  weeklyNoteFolder: string;

  localeOverride: ILocaleOverride;

  // Ollama (local) generated list titles
  ollamaTitlesEnabled: boolean;
  ollamaBaseUrl: string;
  ollamaModel: string;
  ollamaMaxChars: number;
  ollamaRequestTimeoutMs: number;
  ollamaTitleCacheMaxEntries: number;
}

const weekdays = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];

export const defaultSettings = Object.freeze({
  shouldConfirmBeforeCreate: true,
  weekStart: "locale" as IWeekStartOption,

  wordsPerDot: DEFAULT_WORDS_PER_DOT,

  showWeeklyNote: false,
  weeklyNoteFormat: "",
  weeklyNoteTemplate: "",
  weeklyNoteFolder: "",

  localeOverride: "system-default",

  ollamaTitlesEnabled: false,
  ollamaBaseUrl: "http://127.0.0.1:11434",
  ollamaModel: "gemma3:4b",
  ollamaMaxChars: 8000,
  ollamaRequestTimeoutMs: 15000,
  ollamaTitleCacheMaxEntries: 1000,
});

export function appHasPeriodicNotesPluginLoaded(): boolean {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const periodicNotes = (<any>window.app).plugins.getPlugin("periodic-notes");
  return periodicNotes && periodicNotes.settings?.weekly?.enabled;
}

export class CalendarSettingsTab extends PluginSettingTab {
  private plugin: CalendarPlugin;

  constructor(app: App, plugin: CalendarPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    this.containerEl.empty();

    if (!appHasDailyNotesPluginLoaded()) {
      this.containerEl.createDiv("settings-banner", (banner) => {
        banner.createEl("h3", {
          text: "⚠️ Daily Notes plugin not enabled",
        });
        banner.createEl("p", {
          cls: "setting-item-description",
          text:
            "The calendar is best used in conjunction with either the Daily Notes plugin or the Periodic Notes plugin (available in the Community Plugins catalog).",
        });
      });
    }

    this.containerEl.createEl("h3", {
      text: "General Settings",
    });
    this.addDotThresholdSetting();
    this.addWeekStartSetting();
    this.addConfirmCreateSetting();
    this.addShowWeeklyNoteSetting();

    if (
      this.plugin.options.showWeeklyNote &&
      !appHasPeriodicNotesPluginLoaded()
    ) {
      this.containerEl.createEl("h3", {
        text: "Weekly Note Settings",
      });
      this.containerEl.createEl("p", {
        cls: "setting-item-description",
        text:
          "Note: Weekly Note settings are moving. You are encouraged to install the 'Periodic Notes' plugin to keep the functionality in the future.",
      });
      this.addWeeklyNoteFormatSetting();
      this.addWeeklyNoteTemplateSetting();
      this.addWeeklyNoteFolderSetting();
    }

    this.containerEl.createEl("h3", {
      text: "Advanced Settings",
    });
    this.addLocaleOverrideSetting();

    this.containerEl.createEl("h3", {
      text: "Ollama (local)",
    });
    this.addOllamaSettings();
  }

  addDotThresholdSetting(): void {
    new Setting(this.containerEl)
      .setName("Words per dot")
      .setDesc("How many words should be represented by a single dot?")
      .addText((textfield) => {
        textfield.setPlaceholder(String(DEFAULT_WORDS_PER_DOT));
        textfield.inputEl.type = "number";
        textfield.setValue(String(this.plugin.options.wordsPerDot));
        textfield.onChange(async (value) => {
          this.plugin.writeOptions(() => ({
            wordsPerDot: value !== "" ? Number(value) : undefined,
          }));
        });
      });
  }

  addWeekStartSetting(): void {
    const { moment } = window;

    const localizedWeekdays = moment.weekdays();
    const localeWeekStartNum = window._bundledLocaleWeekSpec.dow;
    const localeWeekStart = moment.weekdays()[localeWeekStartNum];

    new Setting(this.containerEl)
      .setName("Start week on:")
      .setDesc(
        "Choose what day of the week to start. Select 'Locale default' to use the default specified by moment.js"
      )
      .addDropdown((dropdown) => {
        dropdown.addOption("locale", `Locale default (${localeWeekStart})`);
        localizedWeekdays.forEach((day, i) => {
          dropdown.addOption(weekdays[i], day);
        });
        dropdown.setValue(this.plugin.options.weekStart);
        dropdown.onChange(async (value) => {
          this.plugin.writeOptions(() => ({
            weekStart: value as IWeekStartOption,
          }));
        });
      });
  }

  addConfirmCreateSetting(): void {
    new Setting(this.containerEl)
      .setName("Confirm before creating new note")
      .setDesc("Show a confirmation modal before creating a new note")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.options.shouldConfirmBeforeCreate);
        toggle.onChange(async (value) => {
          this.plugin.writeOptions(() => ({
            shouldConfirmBeforeCreate: value,
          }));
        });
      });
  }

  addShowWeeklyNoteSetting(): void {
    new Setting(this.containerEl)
      .setName("Show week number")
      .setDesc("Enable this to add a column with the week number")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.options.showWeeklyNote);
        toggle.onChange(async (value) => {
          this.plugin.writeOptions(() => ({ showWeeklyNote: value }));
          this.display(); // show/hide weekly settings
        });
      });
  }

  addWeeklyNoteFormatSetting(): void {
    new Setting(this.containerEl)
      .setName("Weekly note format")
      .setDesc("For more syntax help, refer to format reference")
      .addText((textfield) => {
        textfield.setValue(this.plugin.options.weeklyNoteFormat);
        textfield.setPlaceholder(DEFAULT_WEEK_FORMAT);
        textfield.onChange(async (value) => {
          this.plugin.writeOptions(() => ({ weeklyNoteFormat: value }));
        });
      });
  }

  addWeeklyNoteTemplateSetting(): void {
    new Setting(this.containerEl)
      .setName("Weekly note template")
      .setDesc(
        "Choose the file you want to use as the template for your weekly notes"
      )
      .addText((textfield) => {
        textfield.setValue(this.plugin.options.weeklyNoteTemplate);
        textfield.onChange(async (value) => {
          this.plugin.writeOptions(() => ({ weeklyNoteTemplate: value }));
        });
      });
  }

  addWeeklyNoteFolderSetting(): void {
    new Setting(this.containerEl)
      .setName("Weekly note folder")
      .setDesc("New weekly notes will be placed here")
      .addText((textfield) => {
        textfield.setValue(this.plugin.options.weeklyNoteFolder);
        textfield.onChange(async (value) => {
          this.plugin.writeOptions(() => ({ weeklyNoteFolder: value }));
        });
      });
  }

  addLocaleOverrideSetting(): void {
    const { moment } = window;

    const sysLocale = navigator.language?.toLowerCase();

    new Setting(this.containerEl)
      .setName("Override locale:")
      .setDesc(
        "Set this if you want to use a locale different from the default"
      )
      .addDropdown((dropdown) => {
        dropdown.addOption("system-default", `Same as system (${sysLocale})`);
        moment.locales().forEach((locale) => {
          dropdown.addOption(locale, locale);
        });
        dropdown.setValue(this.plugin.options.localeOverride);
        dropdown.onChange(async (value) => {
          this.plugin.writeOptions(() => ({
            localeOverride: value as ILocaleOverride,
          }));
        });
      });
  }

  private async refreshOllamaStatus(
    statusEl: HTMLElement,
    opts?: {
      pullButton?: ButtonComponent;
      pullModel?: string;
    }
  ): Promise<void> {
    const enabled = this.plugin.options.ollamaTitlesEnabled;
    const baseUrl = this.plugin.options.ollamaBaseUrl;
    const model = this.plugin.options.ollamaModel;
    const timeoutMs = this.plugin.options.ollamaRequestTimeoutMs;

    const pullModel = opts?.pullModel ?? "gemma3:4b";
    const pullButton = opts?.pullButton;

    if (!enabled) {
      statusEl.setText("Ollama titles are disabled.");
      pullButton?.setDisabled(true);
      return;
    }

    statusEl.setText("Checking Ollama status…");
    pullButton?.setDisabled(true);

    try {
      const client = createOllamaClient({ baseUrl, timeoutMs });
      const version = await client.getVersion();
      const tags = await client.listModels();

      const configuredInstalled = isModelInstalled(tags, model);
      const pullInstalled = isModelInstalled(tags, pullModel);

      const versionStr = version?.version ? `v${version.version}` : "unknown";
      statusEl.setText(
        `Ollama: reachable (${versionStr}). Model ${model}: ${
          configuredInstalled ? "installed" : "not installed"
        }.`
      );

      if (pullButton) {
        if (pullInstalled) {
          pullButton.setButtonText(`${pullModel} installed`);
          pullButton.setDisabled(true);
        } else {
          pullButton.setButtonText(`Pull ${pullModel}`);
          pullButton.setDisabled(false);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      statusEl.setText(`Ollama: unreachable (${msg}).`);

      if (pullButton) {
        pullButton.setButtonText(`Pull ${pullModel}`);
        pullButton.setDisabled(true);
      }
    }
  }

  private addOllamaSettings(): void {
    if (Platform.isMobile) {
      this.containerEl.createEl("p", {
        cls: "setting-item-description",
        text:
          "Ollama titles require a local Ollama server and are typically desktop-only.",
      });
    }

    new Setting(this.containerEl)
      .setName("Generate list titles with Ollama")
      .setDesc(
        "Adds a per-note Generate button in the Calendar list view (does not rename files)."
      )
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.options.ollamaTitlesEnabled);
        toggle.onChange(async (value) => {
          await this.plugin.writeOptions(() => ({
            ollamaTitlesEnabled: value,
          }));
          this.display();
        });
      });

    // When disabled, keep the settings UI minimal.
    if (!this.plugin.options.ollamaTitlesEnabled) {
      return;
    }

    new Setting(this.containerEl)
      .setName("Ollama base URL")
      .setDesc("Usually http://127.0.0.1:11434")
      .addText((textfield) => {
        textfield.setPlaceholder("http://127.0.0.1:11434");
        textfield.setValue(this.plugin.options.ollamaBaseUrl);
        textfield.onChange(async (value) => {
          await this.plugin.writeOptions(() => ({
            ollamaBaseUrl: value.trim(),
          }));
        });
      });

    new Setting(this.containerEl)
      .setName("Ollama model")
      .setDesc("Model tag to use, e.g. gemma3:4b")
      .addText((textfield) => {
        textfield.setPlaceholder("gemma3:4b");
        textfield.setValue(this.plugin.options.ollamaModel);
        textfield.onChange(async (value) => {
          await this.plugin.writeOptions(() => ({
            ollamaModel: value.trim(),
          }));
        });
      });

    new Setting(this.containerEl)
      .setName("Max characters sent to model")
      .setDesc("Truncates note content to keep prompts fast")
      .addText((textfield) => {
        textfield.inputEl.type = "number";
        textfield.setValue(String(this.plugin.options.ollamaMaxChars));
        textfield.onChange(async (value) => {
          const num = value !== "" ? Number(value) : undefined;
          await this.plugin.writeOptions(() => ({
            ollamaMaxChars: Number.isFinite(num) ? num : undefined,
          }));
        });
      });

    new Setting(this.containerEl)
      .setName("Request timeout (ms)")
      .setDesc("Applies to status checks and generation")
      .addText((textfield) => {
        textfield.inputEl.type = "number";
        textfield.setValue(String(this.plugin.options.ollamaRequestTimeoutMs));
        textfield.onChange(async (value) => {
          const num = value !== "" ? Number(value) : undefined;
          await this.plugin.writeOptions(() => ({
            ollamaRequestTimeoutMs: Number.isFinite(num) ? num : undefined,
          }));
        });
      });

    new Setting(this.containerEl)
      .setName("Generated title cache size")
      .setDesc("How many generated titles to keep (stored in plugin data)")
      .addText((textfield) => {
        textfield.inputEl.type = "number";
        textfield.setValue(String(this.plugin.options.ollamaTitleCacheMaxEntries));
        textfield.onChange(async (value) => {
          const num = value !== "" ? Number(value) : undefined;
          await this.plugin.writeOptions(() => ({
            ollamaTitleCacheMaxEntries: Number.isFinite(num) ? num : undefined,
          }));
        });
      });

    const statusEl = this.containerEl.createEl("p", {
      cls: "setting-item-description",
      text: "",
    });

    const pullModel = "gemma3:4b";
    let pullButton: ButtonComponent | undefined;

    new Setting(this.containerEl)
      .setName("Pull Gemma 3 4B")
      .setDesc("Downloads gemma3:4b into your local Ollama")
      .addButton((button) => {
        pullButton = button;
        button.setButtonText(`Pull ${pullModel}`);
        button.setDisabled(true);

        button.onClick(async () => {
          try {
            const baseUrl = this.plugin.options.ollamaBaseUrl;
            const timeoutMs = this.plugin.options.ollamaRequestTimeoutMs;
            const client = createOllamaClient({ baseUrl, timeoutMs });

            new Notice(`Pulling ${pullModel}…`);
            await client.pullModel(pullModel);
            new Notice(`Pulled ${pullModel}.`);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            new Notice(`Failed to pull ${pullModel}: ${msg}`);
          } finally {
            void this.refreshOllamaStatus(statusEl, { pullButton, pullModel });
          }
        });
      });

    void this.refreshOllamaStatus(statusEl, { pullButton, pullModel });

    new Setting(this.containerEl)
      .setName("Clear generated titles")
      .setDesc("Removes all stored generated titles")
      .addButton((button) => {
        button.setButtonText("Clear");
        button.onClick(async () => {
          await this.plugin.clearGeneratedTitles();
          new Notice("Cleared generated titles.");
        });
      });
  }
}
