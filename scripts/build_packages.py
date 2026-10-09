#!/usr/bin/env python3
"""Build the two single-language download packages from this one source tree.

    python3 scripts/build_packages.py          # writes dist/学习计时器.zip and dist/study_timer.zip

Each package has the language fixed (no drop-down), contains only that
language's text table and README, and never includes i18n-orig.js.
"""
import os, re, shutil, sys, zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIST = os.path.join(ROOT, "dist")

PACKAGES = {
    "zh": {"name": "学习计时器", "readme": "README.md",    "html_lang": "zh-CN", "drop": "en", "shots": ["timer.png", "calendar.png", "ai-review.png"]},
    "en": {"name": "study_timer", "readme": "README.en.md", "html_lang": "en",    "drop": "zh", "shots": ["en-timer.png", "en-calendar.png", "en-ai-review.png"]},
}
COMMON = ["index.html", "style.css", "app.js", "ai-import.js", "i18n.js", "LICENSE", "demo-data.json"]


def read(p):
    with open(p, encoding="utf-8") as f:
        return f.read()


def write(p, s):
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "w", encoding="utf-8", newline="\n") as f:
        f.write(s)


def sub1(pattern, repl, s, flags=0):
    out, n = re.subn(pattern, repl, s, count=1, flags=flags)
    if n != 1:
        sys.exit("build failed: pattern not found: " + pattern)
    return out


def drop_table(js, lang):
    """Remove `TABLES.<lang> = { ... };` (it ends at the first line that is exactly '  };')."""
    return sub1(r"  TABLES\.%s = \{.*?\n  \};\n\n?" % lang, "", js, re.S)


def build(lang, cfg):
    stage = os.path.join(DIST, "_stage", cfg["name"])
    shutil.rmtree(os.path.join(DIST, "_stage"), ignore_errors=True)
    for f in COMMON:
        os.makedirs(os.path.dirname(os.path.join(stage, f)), exist_ok=True)
        shutil.copy(os.path.join(ROOT, f), os.path.join(stage, f))

    # index.html: fixed language, no selector, no i18n-orig.js
    html = read(os.path.join(stage, "index.html"))
    html = sub1(r'<html lang="[^"]*">', '<html lang="%s">' % cfg["html_lang"], html)
    html = sub1(r'[ \t]*<select id="langSelect".*?</select>\n', "", html)
    html = sub1(r'id="settingsBtn" style="', 'id="settingsBtn" style="margin-left:auto;', html)
    html = re.sub(r'[ \t]*<!--[^>]*i18n-orig[^>]*-->\n', "", html)
    html = re.sub(r'[ \t]*<script src="i18n-orig.js"></script>\n', "", html)
    write(os.path.join(stage, "index.html"), html)

    # i18n.js: keep only this language's table and fix the language
    js = read(os.path.join(stage, "i18n.js"))
    js = drop_table(js, cfg["drop"])
    js = sub1(r"const lang = pickLang\(\);", 'const lang = "%s";' % lang, js)
    write(os.path.join(stage, "i18n.js"), js)

    # README (renamed README.md) with only the screenshots that ship
    readme = read(os.path.join(ROOT, cfg["readme"]))
    readme = re.sub(r"^\[(English README|中文说明[^\]]*)\]\([^)]*\)\n\n", "", readme, flags=re.M)
    write(os.path.join(stage, "README.md"), readme)
    for s in cfg["shots"]:
        dst = os.path.join(stage, "docs", "img", s)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copy(os.path.join(ROOT, "docs", "img", s), dst)

    # zip (top-level folder = package name)
    out = os.path.join(DIST, cfg["name"] + ".zip")
    if os.path.exists(out):
        os.remove(out)
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for d, _, files in os.walk(stage):
            for f in sorted(files):
                full = os.path.join(d, f)
                z.write(full, os.path.relpath(full, os.path.dirname(stage)))
    shutil.rmtree(os.path.join(DIST, "_stage"))
    print("built", out)


if __name__ == "__main__":
    os.makedirs(DIST, exist_ok=True)
    for lang, cfg in PACKAGES.items():
        build(lang, cfg)
