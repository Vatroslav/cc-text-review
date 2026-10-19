#!/usr/bin/env python
"""cc-text-review - Figma-style comments on text, with word-level changes between versions.

Server (the Browser pane starts it through .claude/launch.json):
    python review.py serve [--port 4590]

Commands for Claude (details in CLAUDE.md):
    python review.py list
    python review.py new <slug> "<title>" [--source "..."]
    python review.py open-comments <slug>
    python review.py new-version <slug> [--note "..."]
    python review.py note <slug> <number> "<text>"
    python review.py resolve <slug> <id> "<reply>"
    python review.py reply <slug> <id> "<text>"
    python review.py reject <slug> <id> "<reason>"
    python review.py comment <slug> "<quote>" "<text>" [--nth N]
    python review.py wait <slug> [--hours N]     (run in the background)
    python review.py status <slug>

Standard library only. Data lives in documents/<slug>/: v1.md, v2.md ...,
meta.json (title, source, notes per version) and comments.json. The Send to
Claude button uses listener.json, submit.json and claimed.json there.
"""

import argparse
import hashlib
import json
import os
import re
import shutil
import sys
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DOCUMENTS = ROOT / "documents"
APP = ROOT / "app"
SLUG_RE = re.compile(r"[a-z0-9][a-z0-9-]{0,80}")
VERSION_RE = re.compile(r"v(\d+)\.md")

# Send to Claude: `wait` keeps listener.json fresh, the button writes submit.json,
# and `wait` claims it (renames it to claimed.json), prints the comments and exits.
LISTENER, SUBMIT, CLAIMED = "listener.json", "submit.json", "claimed.json"
HANDOFF_FILES = {LISTENER, SUBMIT, CLAIMED}
FRESH = 10            # seconds: a listener older than this is gone
WORKING = 15 * 60     # seconds: how long "Claude is working" shows without a new listener


# ---------- storage ----------

def now():
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def doc_dir(slug):
    if not SLUG_RE.fullmatch(slug or ""):
        raise ValueError(f"invalid slug: {slug!r}")
    return DOCUMENTS / slug


def versions(slug):
    d = doc_dir(slug)
    if not d.is_dir():
        return []
    numbers = []
    for f in d.iterdir():
        m = VERSION_RE.fullmatch(f.name)
        if m:
            numbers.append(int(m.group(1)))
    return sorted(numbers)


def read_version(slug, number):
    text = (doc_dir(slug) / f"v{number}.md").read_text(encoding="utf-8")
    return text.replace("\r\n", "\n")


def read_json(path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return default


def write_json(path, data):
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def meta(slug):
    return read_json(doc_dir(slug) / "meta.json", {})


def comments(slug):
    return read_json(doc_dir(slug) / "comments.json", [])


def save_comments(slug, items):
    write_json(doc_dir(slug) / "comments.json", items)


def next_id(items):
    highest = 0
    for c in items:
        m = re.fullmatch(r"c(\d+)", c.get("id", ""))
        if m:
            highest = max(highest, int(m.group(1)))
    return f"c{highest + 1}"


def find(items, cid):
    for c in items:
        if c.get("id") == cid:
            return c
    raise KeyError(f"no comment {cid}")


def content_files(d):
    return [f for f in sorted(d.iterdir()) if f.suffix != ".tmp" and f.name not in HANDOFF_FILES]


def revision(slug):
    d = doc_dir(slug)
    h = hashlib.sha1()
    if d.is_dir():
        for f in content_files(d):
            st = f.stat()
            h.update(f"{f.name}:{st.st_mtime_ns}:{st.st_size};".encode())
    return h.hexdigest()[:12]


def age(path):
    try:
        return time.time() - path.stat().st_mtime
    except OSError:
        return None


def handoff(slug):
    """State of the Send to Claude button: sent, working, listening or off."""
    d = doc_dir(slug)
    listener = age(d / LISTENER)
    listening = listener is not None and listener < FRESH
    if (d / SUBMIT).exists():
        return "sent" if listening else "off"
    claimed = age(d / CLAIMED)
    if claimed is not None and claimed < WORKING:
        return "working"
    return "listening" if listening else "off"


def document(slug):
    numbers = versions(slug)
    if not numbers:
        raise FileNotFoundError(slug)
    m = meta(slug)
    notes = m.get("notes", {})
    return {
        "slug": slug,
        "title": m.get("title", slug),
        "source": m.get("source", ""),
        "versions": [
            {"number": n, "text": read_version(slug, n), "note": notes.get(str(n), "")}
            for n in numbers
        ],
        "comments": comments(slug),
        "rev": revision(slug),
        "handoff": handoff(slug),
    }


def list_documents():
    out = []
    if not DOCUMENTS.is_dir():
        return out
    for d in sorted(DOCUMENTS.iterdir()):
        if not d.is_dir() or not SLUG_RE.fullmatch(d.name):
            continue
        numbers = versions(d.name)
        if not numbers:
            continue
        items = comments(d.name)
        out.append({
            "slug": d.name,
            "title": meta(d.name).get("title", d.name),
            "versions": len(numbers),
            "open": sum(1 for c in items if c.get("status") == "open"),
            "modified": max(f.stat().st_mtime for f in content_files(d)),
        })
    out.sort(key=lambda x: x["modified"], reverse=True)
    return out


# ---------- server ----------

TYPES = {".html": "text/html", ".js": "text/javascript", ".css": "text/css"}
STATIC = {"/": "index.html", "/index.html": "index.html", "/app.js": "app.js", "/style.css": "style.css"}


class Handler(BaseHTTPRequestHandler):
    server_version = "cc-text-review/1"

    def log_message(self, fmt, *args):
        if "/rev" in self.path:
            return
        super().log_message(fmt, *args)

    def send(self, status, body, content_type="application/json"):
        if content_type == "application/json":
            body = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", f"{content_type}; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def error(self, status, message):
        self.send(status, {"error": message})

    def body(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length > 200_000:
            raise ValueError("request too large")
        return json.loads(self.rfile.read(length) or b"{}")

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        try:
            if path in STATIC:
                f = APP / STATIC[path]
                return self.send(200, f.read_bytes(), TYPES[f.suffix])
            if path == "/api/documents":
                return self.send(200, list_documents())
            m = re.fullmatch(r"/api/documents/([^/]+)(/rev)?", path)
            if m:
                slug = m.group(1)
                if m.group(2):
                    return self.send(200, {"rev": revision(slug), "handoff": handoff(slug)})
                return self.send(200, document(slug))
            self.error(404, "not found")
        except FileNotFoundError:
            self.error(404, "no such document")
        except ValueError as e:
            self.error(400, str(e))

    def do_POST(self):
        path = self.path.split("?", 1)[0]
        try:
            data = self.body()
            m = re.fullmatch(r"/api/documents/([^/]+)/comments", path)
            if m:
                return self.send(201, add_comment(m.group(1), data))
            m = re.fullmatch(r"/api/documents/([^/]+)/comments/(c\d+)/replies", path)
            if m:
                return self.send(201, add_reply(m.group(1), m.group(2), "user", data.get("text", "")))
            m = re.fullmatch(r"/api/documents/([^/]+)/comments/(c\d+)/reopen", path)
            if m:
                return self.send(200, reopen(m.group(1), m.group(2)))
            m = re.fullmatch(r"/api/documents/([^/]+)/submit", path)
            if m:
                return self.submit(m.group(1))
            self.error(404, "not found")
        except (ValueError, KeyError) as e:
            self.error(400, str(e))
        except FileNotFoundError:
            self.error(404, "no such document")

    def submit(self, slug):
        if not versions(slug):
            raise FileNotFoundError(slug)
        state = handoff(slug)
        if state == "off":
            return self.error(409, "Claude isn't listening. Tell Claude in chat to check the comments.")
        if state == "listening":
            write_json(doc_dir(slug) / SUBMIT, {"time": now()})
        self.send(200, {"handoff": handoff(slug)})

    def do_DELETE(self):
        path = self.path.split("?", 1)[0]
        m = re.fullmatch(r"/api/documents/([^/]+)/comments/(c\d+)", path)
        if not m:
            return self.error(404, "not found")
        try:
            delete_comment(m.group(1), m.group(2))
            self.send(200, {"ok": True})
        except (ValueError, KeyError) as e:
            self.error(400, str(e))


def clean_text(text, limit):
    text = (text or "").strip()
    if not text:
        raise ValueError("empty text")
    if len(text) > limit:
        raise ValueError("text too long")
    return text


def position(p):
    if not isinstance(p, dict):
        raise ValueError("invalid position")
    return {"block": int(p["block"]), "char": int(p["char"])}


def add_comment(slug, data):
    numbers = versions(slug)
    if not numbers:
        raise FileNotFoundError(slug)
    if int(data.get("version", 0)) != numbers[-1]:
        raise ValueError("only the latest version can be commented on")
    items = comments(slug)
    c = {
        "id": next_id(items),
        "version": numbers[-1],
        "author": "user",
        "quote": clean_text(data.get("quote"), 5000),
        "before": (data.get("before") or "")[-80:],
        "after": (data.get("after") or "")[:80],
        "start": position(data.get("start")),
        "end": position(data.get("end")),
        "text": clean_text(data.get("text"), 5000),
        "status": "open",
        "time": now(),
        "replies": [],
    }
    items.append(c)
    save_comments(slug, items)
    return c


def add_reply(slug, cid, author, text):
    items = comments(slug)
    c = find(items, cid)
    c.setdefault("replies", []).append({"author": author, "text": clean_text(text, 5000), "time": now()})
    save_comments(slug, items)
    return c


def reopen(slug, cid):
    items = comments(slug)
    c = find(items, cid)
    c["status"] = "open"
    c.pop("resolved_in", None)
    save_comments(slug, items)
    return c


def delete_comment(slug, cid):
    items = comments(slug)
    c = find(items, cid)
    if c.get("author") != "user" or c.get("status") != "open" or c.get("replies"):
        raise ValueError("only your own open comment without replies can be deleted")
    save_comments(slug, [x for x in items if x is not c])


def serve(port):
    DOCUMENTS.mkdir(exist_ok=True)
    srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"cc-text-review: http://localhost:{port}/", flush=True)
    srv.serve_forever()


# ---------- commands ----------

def short(text, n=160):
    text = " ".join(text.split())
    return text if len(text) <= n else text[: n - 1] + "…"


def author_name(author):
    return "Claude" if author == "claude" else "User"


def cmd_list(a):
    for d in list_documents():
        print(f"{d['slug']}: {d['title']} (version {d['versions']}, {d['open']} open)")


def cmd_new(a):
    d = doc_dir(a.slug)
    if d.exists():
        sys.exit(f"{a.slug} already exists")
    d.mkdir(parents=True)
    write_json(d / "meta.json", {"title": a.title, "source": a.source or "", "notes": {}})
    save_comments(a.slug, [])
    print(f"Write the first version to: {d / 'v1.md'}")


def cmd_open_comments(a):
    items = [c for c in comments(a.slug) if c.get("status") == "open"]
    latest = versions(a.slug)[-1]
    if not items:
        print("No open comments.")
        return
    print(f"Latest version: v{latest}. Open comments: {len(items)}\n")
    for c in items:
        print(f"{c['id']} (v{c['version']}, {author_name(c.get('author'))})")
        context = f"…{c.get('before', '')}[[{c['quote']}]]{c.get('after', '')}…"
        print(f"  where: {short(context, 400)}")
        print(f"  comment: {c['text']}")
        for r in c.get("replies", []):
            print(f"  {author_name(r['author'])}: {r['text']}")
        print()


def cmd_new_version(a):
    numbers = versions(a.slug)
    if not numbers:
        sys.exit(f"{a.slug} has no versions")
    d = doc_dir(a.slug)
    new = d / f"v{numbers[-1] + 1}.md"
    shutil.copyfile(d / f"v{numbers[-1]}.md", new)
    if a.note:
        set_note(a.slug, numbers[-1] + 1, a.note)
    print(f"Copied v{numbers[-1]} to {new}. Change only the commented places.")


def set_note(slug, number, text):
    m = meta(slug)
    m.setdefault("notes", {})[str(number)] = text
    write_json(doc_dir(slug) / "meta.json", m)


def cmd_note(a):
    set_note(a.slug, a.number, a.text)
    print(f"Note for v{a.number} saved.")


def cmd_resolve(a):
    items = comments(a.slug)
    c = find(items, a.id)
    c["status"] = "resolved"
    c["resolved_in"] = versions(a.slug)[-1]
    c.setdefault("replies", []).append({"author": "claude", "text": clean_text(a.reply, 5000), "time": now()})
    save_comments(a.slug, items)
    print(f"{a.id} resolved in v{c['resolved_in']}.")


def cmd_reply(a):
    add_reply(a.slug, a.id, "claude", a.text)
    print(f"Reply to {a.id} saved; the comment stays open.")


def cmd_reject(a):
    items = comments(a.slug)
    c = find(items, a.id)
    c["status"] = "rejected"
    c.setdefault("replies", []).append({"author": "claude", "text": clean_text(a.reason, 5000), "time": now()})
    save_comments(a.slug, items)
    print(f"{a.id} rejected.")


def cmd_comment(a):
    latest = versions(a.slug)[-1]
    source = read_version(a.slug, latest)
    if a.quote not in re.sub(r"[*_`~]", "", source):
        print("Warning: quote not found in the latest version (quote the text as displayed, without markdown markers).")
    items = comments(a.slug)
    c = {
        "id": next_id(items),
        "version": latest,
        "author": "claude",
        "quote": clean_text(a.quote, 5000),
        "nth": a.nth,
        "text": clean_text(a.text, 5000),
        "status": "open",
        "time": now(),
        "replies": [],
    }
    items.append(c)
    save_comments(a.slug, items)
    print(f"Comment {c['id']} added to v{latest}.")


def listener_token(d):
    """Token of the current listener, None if there is none; raises ValueError while it is rewritten."""
    try:
        return json.loads((d / LISTENER).read_text(encoding="utf-8")).get("token")
    except FileNotFoundError:
        return None
    except OSError as e:
        raise ValueError(e)


def cmd_wait(a):
    """Block until the user presses Send to Claude, then print the open comments and exit.

    Claude runs this in the background; its exit wakes the session. A newer `wait` on the
    same document takes over, and this one exits.
    """
    if not versions(a.slug):
        sys.exit(f"no document {a.slug}")
    d = doc_dir(a.slug)
    token = f"{os.getpid()}-{time.time_ns()}"
    for name in (SUBMIT, CLAIMED):
        (d / name).unlink(missing_ok=True)
    write_json(d / LISTENER, {"token": token, "since": now()})
    deadline = time.time() + a.hours * 3600
    try:
        while time.time() < deadline:
            time.sleep(1)
            try:
                if listener_token(d) != token:
                    print(f"Another listener took over {a.slug}; nothing to do.")
                    return
            except ValueError:
                continue
            try:
                os.replace(d / SUBMIT, d / CLAIMED)
            except FileNotFoundError:
                pass
            except OSError:
                continue
            else:
                print(f"The user pressed Send to Claude on {a.slug}. Do the round, then start `wait` again.\n")
                cmd_open_comments(a)
                return
            try:
                os.utime(d / LISTENER)
            except OSError:
                pass
        print(f"Stopped listening for {a.slug} after {a.hours:g} hours; the page now says Claude isn't listening.")
    finally:
        try:
            if listener_token(d) == token:
                (d / LISTENER).unlink()
        except (OSError, ValueError):
            pass


def cmd_status(a):
    print({
        "listening": "Listening: the Send to Claude button wakes the session that ran `wait`.",
        "sent": "Sent: the user pressed Send to Claude; the listener picks it up within a second.",
        "working": "Working: a listener picked up Send to Claude; start `wait` again after the round.",
        "off": "Not listening: start `review.py wait` in the background.",
    }[handoff(a.slug)])


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    p = argparse.ArgumentParser(description="Figma-style comments on text, with changes between versions")
    sub = p.add_subparsers(dest="command", required=True)

    s = sub.add_parser("serve")
    s.add_argument("--port", type=int, default=4590)
    sub.add_parser("list")
    s = sub.add_parser("new")
    s.add_argument("slug")
    s.add_argument("title")
    s.add_argument("--source")
    s = sub.add_parser("open-comments")
    s.add_argument("slug")
    s = sub.add_parser("new-version")
    s.add_argument("slug")
    s.add_argument("--note")
    s = sub.add_parser("note")
    s.add_argument("slug")
    s.add_argument("number", type=int)
    s.add_argument("text")
    for name, field in (("resolve", "reply"), ("reply", "text"), ("reject", "reason")):
        s = sub.add_parser(name)
        s.add_argument("slug")
        s.add_argument("id")
        s.add_argument(field)
    s = sub.add_parser("comment")
    s.add_argument("slug")
    s.add_argument("quote")
    s.add_argument("text")
    s.add_argument("--nth", type=int, default=1)
    s = sub.add_parser("wait")
    s.add_argument("slug")
    s.add_argument("--hours", type=float, default=8)
    s = sub.add_parser("status")
    s.add_argument("slug")

    a = p.parse_args()
    if a.command == "serve":
        return serve(a.port)
    {
        "list": cmd_list,
        "new": cmd_new,
        "open-comments": cmd_open_comments,
        "new-version": cmd_new_version,
        "note": cmd_note,
        "resolve": cmd_resolve,
        "reply": cmd_reply,
        "reject": cmd_reject,
        "comment": cmd_comment,
        "wait": cmd_wait,
        "status": cmd_status,
    }[a.command](a)


if __name__ == "__main__":
    main()
