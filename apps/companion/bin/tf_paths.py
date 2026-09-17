"""
Where the launcher keeps its state, and whether a process is still alive.

Both answers are platform-dependent and both have a counterpart on the Node
side -- `packages/personal/src/data-dir.ts`. They are asserted to agree in
`src/launcher.test.ts`, because a launcher writing drafts to one directory
while the status line reads another produces no error anywhere: the bar simply
never mentions a draft.
"""

import ntpath
import os
import posixpath
import sys


def _clean(value):
    """`value` with surrounding space removed, or None when it says nothing."""
    if not isinstance(value, str):
        return None
    trimmed = value.strip()
    return trimmed or None


def data_dir(platform=None, env=None, home=None):
    """The application-support directory, by the same rule Node uses."""
    platform = platform or sys.platform
    env = os.environ if env is None else env
    home = home or os.path.expanduser("~")
    windows = platform.startswith("win")
    path = ntpath if windows else posixpath

    override = _clean(env.get("TOKEN_FORECASTER_DATA_DIR"))
    if override:
        return override

    if windows:
        local = _clean(env.get("LOCALAPPDATA")) or path.join(home, "AppData", "Local")
        return path.join(local, "TokenForecaster")
    if platform.startswith("darwin"):
        return path.join(home, "Library", "Application Support", "TokenForecaster")
    state = _clean(env.get("XDG_STATE_HOME")) or path.join(home, ".local", "state")
    return path.join(state, "token-forecaster")


def draft_dir(platform=None, env=None, home=None):
    """Where the counts for the line being typed are published."""
    platform = platform or sys.platform
    path = ntpath if platform.startswith("win") else posixpath
    return path.join(data_dir(platform, env, home), "drafts")


def ensure_draft_dir():
    """The draft directory, created private to this user."""
    path = draft_dir()
    os.makedirs(path, mode=0o700, exist_ok=True)
    return path


def process_alive(pid):
    """
    Whether `pid` is still running.

    On POSIX this is signal 0. On Windows it emphatically is not: `os.kill`
    there has no null-signal probe -- it opens the process and calls
    TerminateProcess with the signal number as the exit code, so the POSIX
    idiom would kill every launcher whose draft file this swept past.
    """
    if os.name == "nt":
        import ctypes
        from ctypes import wintypes

        SYNCHRONIZE = 0x00100000
        WAIT_TIMEOUT = 0x00000102
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        # Declared, not inferred: a handle is 64 bits and ctypes defaults every
        # return value to a 32-bit int, which would truncate it into a handle
        # that is not the one that was opened.
        kernel32.OpenProcess.restype = wintypes.HANDLE
        kernel32.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
        kernel32.WaitForSingleObject.restype = wintypes.DWORD
        kernel32.WaitForSingleObject.argtypes = (wintypes.HANDLE, wintypes.DWORD)
        kernel32.CloseHandle.argtypes = (wintypes.HANDLE,)

        handle = kernel32.OpenProcess(SYNCHRONIZE, False, int(pid))
        if not handle:
            return False  # gone, or ours to know nothing about
        try:
            return kernel32.WaitForSingleObject(handle, 0) == WAIT_TIMEOUT
        finally:
            kernel32.CloseHandle(handle)
    try:
        os.kill(int(pid), 0)
    except ProcessLookupError:
        return False
    except OSError:
        # Alive, but not ours to signal.
        return True
    return True
