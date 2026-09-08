"""
Runs INSIDE the ephemeral, network-less executor container. Reads one
JSON payload from stdin, executes the admin-submitted Filter class, and
writes exactly one JSON line to stdout as the final line — the
sandbox-runner service parses that last line as the result.

Contract the admin's code must follow (matches OpenWebUI Filters):

    class Filter:
        def inlet(self, body: dict, user: dict) -> dict:
            # mutate/return body before it goes to the model, or raise
            # to block the message entirely
            return body

        def outlet(self, body: dict, user: dict) -> dict:
            # mutate/return body (the assistant's reply) after generation
            return body

Only one of inlet/outlet needs to be defined — whichever hook wasn't
requested is simply never called.

`body` for inlet is `{"content": "<user message>"}`.
`body` for outlet is `{"content": "<assistant reply>"}`.
`user` is `{"id": ..., "email": ..., "role": ...}` — never anything more
sensitive (no password hashes, no tokens) is shipped in.
"""

import json
import sys
import traceback


HOOK_TO_CLASS = {
    "inlet": "Filter",
    "outlet": "Filter",
    "pipe": "Pipe",
    "action": "Action",
}


def main() -> None:
    raw = sys.stdin.readline()
    try:
        payload = json.loads(raw)
        hook = payload["hook"]
        code = payload["code"]
        body = payload["body"]
        user = payload["user"]
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": f"Invalid payload: {exc}"}))
        return

    # Executed with a deliberately bare builtins set is NOT attempted here
    # (bypassable, gives false confidence). The real boundary is the
    # container: no network, read-only fs, dropped caps, non-root, tight
    # cpu/mem/time limits — see sandbox-runner/app.py.
    namespace: dict = {}
    try:
        exec(code, namespace)  # noqa: S102
    except Exception:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": f"Code failed to load:\n{traceback.format_exc()}"}))
        return

    class_name = HOOK_TO_CLASS.get(hook, "Filter")
    target_cls = namespace.get(class_name)
    if target_cls is None:
        print(json.dumps({"ok": False, "error": f"Code must define a class named `{class_name}` for hook '{hook}'."}))
        return

    try:
        instance = target_cls()
        handler = getattr(instance, hook, None)
        if handler is None:
            if hook in ("inlet", "outlet"):
                # Hook not implemented on this filter — pass body through
                # unchanged rather than erroring, same as OpenWebUI (a
                # Filter is allowed to only implement one of the two).
                print(json.dumps({"ok": True, "body": body}))
                return
            print(json.dumps({"ok": False, "error": f"`{class_name}` must implement a `{hook}()` method."}))
            return
        result = handler(body, user)
        if not isinstance(result, dict):
            print(json.dumps({"ok": False, "error": f"{hook}() must return a dict, got {type(result).__name__}"}))
            return
        print(json.dumps({"ok": True, "body": result}))
    except Exception:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": f"{hook}() raised:\n{traceback.format_exc()}"}))


if __name__ == "__main__":
    main()
