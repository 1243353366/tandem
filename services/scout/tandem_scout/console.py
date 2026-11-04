"""Console output that cannot lie about where a line came from.

Two kinds of line reach an operator's terminal: things this program says, and things
someone else wrote that this program is relaying. Once both are plain text with no
marker, a reader has to guess, and a payload that can forge a line is indistinguishable
from a real one. Every line therefore arrives with its provenance attached:

    [tandem] scanned 240 public items across 9 source(s)
      ┆ github ┆ alice · priority 0.81

`[tandem]` means we said it. A line beginning with `┆` carries text written by someone
else, named between the two markers. The marker is applied after sanitising, and any
marker character inside the content is replaced, so content cannot close the frame or
open one of ours. Content is also flattened to a single line, so it cannot append a
second line at the left margin.
"""

from __future__ import annotations

from .injection import visible

OURS = "[tandem]"
MARK = "┆"
WIDTH = 120


def clean(value: object) -> str:
    """One safe line: no controls, no escapes, no markers, no fence, no newlines."""
    text = visible(str(value))
    text = text.replace('```', "'''").replace("~~~", "'''")
    return text.replace(MARK, "|").replace("|", "/")


def ours(message: object) -> str:
    """A line this program is responsible for."""
    return f"{OURS} {clean(message)}"[: WIDTH + len(OURS) + 1]


def relayed(fields: list[object], source: object) -> str:
    """A line whose content someone else wrote, framed and attributed."""
    body = " · ".join(clean(field) for field in fields if str(field).strip())
    return f"  {MARK} {clean(source)[:24] or 'unknown'} {MARK} {body}"[:WIDTH]


def say(message: object) -> None:
    print(ours(message))


def relay(fields: list[object], source: object) -> None:
    print(relayed(fields, source))


def sanitize_block(text: object) -> str:
    """Lines for a fenced block this program wrote, that cannot close the fence.

    A draft quotes their handle, so the line is ours and theirs at once: controls are
    stripped, each line stands alone, and nothing in it can end the code fence early.
    """
    out: list[str] = []
    for line in str(text).splitlines() or [""]:
        out.append(visible(line).replace("```", "'''").replace("~~~", "'''"))
    return "\n".join(out)


def url(value: object) -> str:
    """A URL as one safe line. No marker rewriting: a query string may contain one."""
    return visible(str(value)).replace(" ", "%20")
