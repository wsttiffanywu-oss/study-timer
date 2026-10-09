# Study Timer

A local-first study timer and weekly timetable for students. Track how long you spend on each course, see it next to your class schedule, and keep everything on your own computer.

## Features

- Timer with start / pause / resume / stop, plus notes for each session
- Weekly calendar: classes, office hours, optional activities, exams, and the time you actually studied
- Paused stretches show up as hatched stripes inside one continuous study block
- Edit a record's start/end time, course, and note; deleted records go to a "recently deleted" bin for 10 days
- Backup and restore through JSON files
- Your data stays in your browser (SQLite via sql.js, saved to IndexedDB). Nothing is uploaded anywhere

## How to use

1. Download this repository (green **Code** button, then **Download ZIP**) and unzip it
2. Double-click `index.html` to open it in your browser
3. Add your courses and schedule in the **课表** tab, or import a JSON backup

The first load needs internet once to fetch the sql.js library from a CDN.

## Importing a schedule from JSON

The **导入JSON备份** button accepts a file shaped like this:

```json
{
  "courses": ["MAT101"],
  "events": [
    {
      "id": "e-example-1",
      "course": "MAT101",
      "kind": "class",
      "type": "recurring",
      "day": 0,
      "start": "10:00",
      "end": "11:00",
      "loc": "Room 101"
    }
  ],
  "records": []
}
```

`kind` is one of `class`, `officehour`, `activity`, `exam`. `type` is `recurring` (with `day`, 0 = Monday) or `oneoff` (with `date`, `YYYY-MM-DD`). Each event needs a unique `id`.

## Roadmap

- [x] Settings page for your own Claude API key (stored only in your browser, never included in backups)
- [ ] Import a schedule from a screenshot, a photo of a handwritten timetable, or pasted text, with a review step before anything is saved

## Status

Personal project, work in progress.
