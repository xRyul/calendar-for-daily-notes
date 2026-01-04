import type { TFile, moment } from "obsidian";
import type { ICalendarSource, IDayMetadata } from "obsidian-calendar-ui";
import { getDailyNote, getWeeklyNote } from "obsidian-daily-notes-interface";
import { get } from "svelte/store";

import { dailyNotes, weeklyNotes } from "../stores";
import { classList } from "../utils";

const getStreakClasses = (file: TFile): string[] => {
  return classList({
    "has-note": !!file,
  });
};

export const streakSource: ICalendarSource = {
  getDailyMetadata: (date: moment.Moment): Promise<IDayMetadata> => {
    const file = getDailyNote(date, get(dailyNotes));
    return Promise.resolve({
      classes: getStreakClasses(file),
      dots: [],
    });
  },

  getWeeklyMetadata: (date: moment.Moment): Promise<IDayMetadata> => {
    const file = getWeeklyNote(date, get(weeklyNotes));
    return Promise.resolve({
      classes: getStreakClasses(file),
      dots: [],
    });
  },
};
