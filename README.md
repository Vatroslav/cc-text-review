# cc-text-review

Figma-style comments on text for [Claude Code](https://claude.com/claude-code). Select words,
leave a comment, let Claude write the next version, and see exactly what changed, word by word,
next to the comment that asked for it.

Built for the moment when a chat reply stops working: the same text (a story, an email, a
description) goes through several rounds, and re-reading the whole thing every time to find what
changed gets old fast.

## What it does

- **Comments anchored to words.** Select any part of the text and comment on it. The selection
  stays highlighted, and comments can carry a short thread of replies.
- **Versions, never edits in place.** Each round is a new file (`v1.md`, `v2.md` ...). Older
  versions are read-only.
- **Word-level changes.** The Changes view shows deleted and inserted words between two versions,
  and links each change to the comment that caused it.
- **Changes nobody asked for stand out.** Anything changed outside the commented places is
  outlined in dashed orange, so unrequested edits cannot slip through.
- **Claude can comment too**, for example to ask about a fact before changing it.

It runs as a small local web page, ideal for the Browser pane of the Claude Code desktop app, next
to the conversation.

## Requirements

Python 3.8 or newer. Standard library only; nothing to install.

## Run it

```bash
python review.py serve
```

Then open <http://localhost:4590/>. The bundled example (`documents/example-weekly-sync/`) shows a
finished round: three comments on v1, the v2 that resolves them, and one change that nobody
commented on.

In the Claude Code desktop app, add this to `.claude/launch.json` of the project you work in and
start it with the Browser pane (`preview_start`):

```json
{
  "name": "cc-text-review",
  "runtimeExecutable": "python",
  "runtimeArgs": ["/path/to/cc-text-review/review.py", "serve", "--port", "4590"],
  "port": 4590
}
```

## A round with Claude

You comment in the page; Claude works through these commands (full instructions for Claude are
in [CLAUDE.md](CLAUDE.md)):

```bash
python review.py new <slug> "<title>"          # then write documents/<slug>/v1.md
python review.py open-comments <slug>          # read the open comments
python review.py new-version <slug> --note ".." # copy the latest version into the next one
python review.py resolve <slug> <id> "<reply>"  # also: reply, reject, comment, note, list
```

Claude edits only the commented places in the new version; the page notices the new version and
switches to the Changes view on its own.

## Where your text lives

Documents are plain files in `documents/<slug>/`: the versions as markdown, `meta.json` and
`comments.json`. Everything in `documents/` except the bundled example is ignored by git, so the
texts you review stay on your machine.

The server listens on `127.0.0.1` only.

## License

MIT with the Commons Clause; see [LICENSE](LICENSE).
