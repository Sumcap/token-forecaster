"""
Prompt aggregates for a draft that is still being typed.

A port of `extractPromptFeatures` from `@token-forecaster/core`, kept in Python
so the launcher can reduce a keystroke buffer to counts without paying for a
Node start on every character. `test/draft-parity.test.ts` runs both against the
same prompts and fails if they ever disagree, which is what keeps a live
forecast conditioned exactly the way the trained rungs were.

The `\\w` classes are ASCII on purpose: JavaScript's are, and a port that
quietly counted more paths would forecast off a different feature than the one
the profile was built on.
"""

import math
import re

URL_RE = re.compile(r"https?://\S+", re.ASCII)
PATH_RE = re.compile(r"(?:^|\s)(?:~|\.{1,2})?/[\w.\-/]+", re.ASCII)
IMPERATIVE_RE = re.compile(
    r"^\s*(?:please\s+)?(add|fix|build|write|create|implement|refactor|remove|delete|"
    r"update|make|run|test|check|review|explain|find|debug|port|migrate|rename|"
    r"optimi[sz]e|document|investigate|audit|generate|convert|extract|split|merge|"
    r"deploy|install|setup|set up)\b",
    re.IGNORECASE | re.ASCII,
)


def estimate_tokens(text: str) -> int:
    """
    Input tokens in the draft, by the same heuristic `@token-forecaster/token-
    counter` uses: roughly four ASCII characters to a token, non-Latin text
    denser. It is an estimate and is labelled as one on the bar — the point is a
    number that moves with the keystrokes, not a tokenizer in the input path.
    """
    if not text:
        return 0
    ascii_chars = sum(1 for ch in text if ord(ch) < 128)
    return math.ceil(ascii_chars / 4 + (len(text) - ascii_chars) / 1.8)


def features(text: str) -> dict:
    """Counts only. The text is never returned, stored or logged."""
    normalised = text.replace("\r\n", "\n").strip()
    fence_runs = normalised.count("```")
    return {
        "chars": len(normalised),
        "words": 0 if not normalised else len(re.split(r"\s+", normalised, flags=re.ASCII)),
        "lines": 0 if not normalised else normalised.count("\n") + 1,
        "codeFences": fence_runs // 2,
        "urls": len(URL_RE.findall(normalised)),
        "paths": len(PATH_RE.findall(normalised)),
        "hasQuestion": "?" in normalised,
        "hasImperative": bool(IMPERATIVE_RE.search(normalised)),
        "images": 0,
        # Blank by design: the hash matches repeated prompts during training and
        # has no part in a forecast.
        "hash": "",
    }
