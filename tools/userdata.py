"""Where the screensaver keeps the user's own files: a `screensaver` folder in OpenRCT2's user
directory (Documents\\OpenRCT2\\screensaver on Windows), beside the `sequence`, `plugin` and
`object` folders the tools install into (owner, 2026-10-31). It holds the playlists and park
profiles the settings page saves (`playlists/`, `parks/`), its backups, its last two sets of
renders and its own settings. The repository's `playlists/` and `parks/` are the shipped
defaults: a user profile with the same file name replaces the repository's. RCT_SCREENSAVER_HOME
points it elsewhere (tests, a second setup).
"""
import os, sys


def openrct2_dir():
    """OpenRCT2's user directory: Documents\\OpenRCT2 on Windows (honouring folder
    redirection, as OpenRCT2 does), XDG config on Linux, Application Support on macOS."""
    if sys.platform == "win32":
        import ctypes, uuid
        documents = uuid.UUID("{FDD39AD0-238F-46AF-ADB4-6C85480369C7}")  # FOLDERID_Documents
        guid = (ctypes.c_byte * 16).from_buffer_copy(documents.bytes_le)
        path = ctypes.c_wchar_p()
        if ctypes.windll.shell32.SHGetKnownFolderPath(ctypes.byref(guid), 0, None, ctypes.byref(path)) == 0:
            result = path.value
            ctypes.windll.ole32.CoTaskMemFree(path)
            return os.path.join(result, "OpenRCT2")
        return os.path.join(os.path.expanduser("~"), "Documents", "OpenRCT2")
    if sys.platform == "darwin":
        return os.path.expanduser("~/Library/Application Support/OpenRCT2")
    return os.path.join(os.environ.get("XDG_CONFIG_HOME") or os.path.expanduser("~/.config"), "OpenRCT2")


def home():
    return os.environ.get("RCT_SCREENSAVER_HOME") or os.path.join(openrct2_dir(), "screensaver")


def playlists():
    return os.path.join(home(), "playlists")


def parks():
    return os.path.join(home(), "parks")
