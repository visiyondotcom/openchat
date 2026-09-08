"""
Runs INSIDE the ephemeral, network-less executor container — same image and
isolation as run_filter.py (see sandbox-runner/app.py for the container
boundary: no network, read-only fs, dropped caps, non-root, cpu/mem/pids/
time limits). This script is for arbitrary, top-level Python scripts (the
"Run" button on a code block, or the run_python tool), not the
Filter/Pipe/Action class contract run_filter.py handles.

Reads one JSON payload from stdin: {"code": "<script>", "stdin": "<optional
input the script's own stdin reads see>"}. Writes exactly one JSON line to
stdout as the final line — sandbox-runner parses that last line as the
result: {"ok": bool, "stdout": str, "stderr": str, "error": str|null}.
"""

import contextlib
import io
import json
import sys
import traceback

MAX_OUTPUT_CHARS = 20_000


def truncate(s: str) -> str:
    return s if len(s) <= MAX_OUTPUT_CHARS else s[:MAX_OUTPUT_CHARS] + "\n…(truncated)"


def main() -> None:
    raw = sys.stdin.readline()
    try:
        payload = json.loads(raw)
        code = payload["code"]
        stdin_data = payload.get("stdin", "") or ""
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"ok": False, "stdout": "", "stderr": "", "error": f"Invalid payload: {exc}"}))
        return

    stdout_buf = io.StringIO()
    stderr_buf = io.StringIO()
    real_stdin = sys.stdin
    sys.stdin = io.StringIO(stdin_data)
    try:
        with contextlib.redirect_stdout(stdout_buf), contextlib.redirect_stderr(stderr_buf):
            exec(compile(code, "<run_python>", "exec"), {"__name__": "__main__"})  # noqa: S102
        print(json.dumps({
            "ok": True,
            "stdout": truncate(stdout_buf.getvalue()),
            "stderr": truncate(stderr_buf.getvalue()),
            "error": None,
        }))
    except SystemExit as exc:
        # sys.exit(0) / sys.exit() -> success; anything else -> failure, same
        # convention as a shell exit code.
        exit_code = exc.code if isinstance(exc.code, int) else (0 if exc.code is None else 1)
        print(json.dumps({
            "ok": exit_code == 0,
            "stdout": truncate(stdout_buf.getvalue()),
            "stderr": truncate(stderr_buf.getvalue()),
            "error": None if exit_code == 0 else f"Script called sys.exit({exit_code!r})",
        }))
    except Exception:  # noqa: BLE001
        # Traceback goes into stderr (where a real terminal would put it),
        # not into `error` — `error` stays a short one-line summary so the
        # caller can show/log it without duplicating the full stderr text.
        stderr_buf.write(traceback.format_exc())
        print(json.dumps({
            "ok": False,
            "stdout": truncate(stdout_buf.getvalue()),
            "stderr": truncate(stderr_buf.getvalue()),
            "error": "Script raised an exception — see stderr.",
        }))
    finally:
        sys.stdin = real_stdin


if __name__ == "__main__":
    main()
