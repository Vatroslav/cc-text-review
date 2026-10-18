# cc-text-review

Figma-style comments on longer text: Vatra selects words and leaves a comment, Claude writes a
new version changing only the commented places, and the page shows the word-level changes and
which comment each belongs to. Replaces Reply in chat when the same text goes through several
rounds (a story, an email, a description, copy). Created 18 Oct 2026.

Vatra calls it "komentari" ("otvori u komentarima", "pogledaj komentare"). The conversation with
him stays in Croatian; everything in this repo (code, UI, docs, commit messages) is in English.
Document content stays in the language it was written in.

When to use: text Vatra needs to review and correct over several rounds. A short question or a
one-off answer stays in chat.

## Parts

- `review.py` - the server (standard library only, `127.0.0.1:4590`) and commands for Claude.
- `app/` - the page: `index.html`, `app.js` (markdown, version comparison, comments), `style.css`.
- `documents/<slug>/` - one document: `v1.md`, `v2.md` ... (a version never changes once Vatra
  starts commenting on it), `meta.json` (title, source, Claude's note per version), `comments.json`.

The page polls every 2 seconds: when a new version appears, it switches to the changes view.

## The round (Claude)

1. **New document.** `python review.py new <slug> "<title>" --source "<repo, file>"`, then Write
   the text to `documents/<slug>/v1.md` (markdown: headings, paragraphs, lists, bold, tables).
2. **Open it for Vatra.** `preview_start` with the name `cc-text-review` (configured in
   `.claude/launch.json` of this repo and of personal-os; add the same entry in another repo),
   then `navigate` to `http://localhost:4590/#/<slug>`. Vatra comments in the Browser pane.
3. **"Pogledaj komentare".** `python review.py open-comments <slug>` prints every open comment
   with its place (`[[quote]]` in the surrounding text) and messages.
4. **New version.** `python review.py new-version <slug> --note "<what I changed>"` copies the
   latest version into the next one. Then **Edit** only the commented places, never Write the
   whole text: anything changed outside the comments is shown dashed orange as "changes without
   your comment". If such a change is intentional (e.g. the same fix carried into a summary),
   say so in the note.
5. **Close the comments.** For each one: `resolve <slug> <id> "<short reply>"` (done),
   `reply <slug> <id> "<question>"` (need more information, stays open) or
   `reject <slug> <id> "<reason>"` (I disagree; Vatra can reopen it). Keep replies short, as on a
   card: what was done, without repeating the text.
6. **In chat**, one or two sentences in Croatian: which version is ready and whether any
   questions are open. Do not print the text again; Vatra reads it on the page.

Claude can leave a comment too (a factual question, a suggestion):
`python review.py comment <slug> "<quote as displayed, without ** or _>" "<text>" [--nth N]`.

When the text is final, it goes back to its own repo (the source in `meta.json`). That repo is
the source of truth for the content; the rounds stay only on this machine, in `documents/`.

## Rules

- **This repo is public.** Texts under review are private: `documents/` is git-ignored except
  `documents/example-*/`. Never commit a real document, never force-add one, and keep commit
  messages free of document content and of which repo a text came from.
- Run the commands with `PYTHONIOENCODING=utf-8` in Git Bash (Croatian characters in output).
- `resolve` records the number of the latest version, so call it only after `new-version`.
- Only the latest version can be commented on, in both the Text and the Changes view (a
  selection across deleted text counts only the latest version's text); older versions are
  read-only, for reading and comparison.
- Do not edit `comments.json` by hand while the server runs; use the commands (the server and
  the commands write the same file atomically).
