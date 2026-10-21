#!/usr/bin/env python3
"""Every workflow job that runs or builds from a pinned image must get it through .github/actions/pinned-images, first.

For each job in .github/workflows/*.yml this works out which *_IMAGE names of PINS the job reaches (an image the job's own commands
use as "$NAME" in a docker command, or one that a script the job runs uses, through the scripts that script calls), and checks that
the job has a pinned-images step after its checkout and before the first step that needs an image, and that the step names every
image the job reaches. Plain text matching on purpose: no YAML library, nothing to install.
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ACTION = "./.github/actions/pinned-images"
# Scripts that only read PINS, or run against a stand-in docker: they never pull, so a job that runs them reaches no image through them.
NO_PULL = {
    "tests/static.sh", "tests/network_static.sh", "tests/demo_static.sh", "tests/demo_explorer_static.sh", "tests/ci_images_static.py",
    "tests/persist_scripts.sh", "tests/network_checks.sh", "tests/refuses_missing_flag.sh", "tests/pinned_images.sh",
}
SKIP_DIRS = {".git", "node_modules", "target", "dist", ".github"}
IMAGE = r"[A-Z][A-Z0-9_]*_IMAGE"
USE = re.compile(r'"\$\{?(' + IMAGE + r')\b[^"]*"|--build-arg[ =]"?(' + IMAGE + r")=")
DOCKER = re.compile(r"\bdocker\w*\s+(run|build|create|pull|buildx)\b|\bdocker_\s|\bquietly\s+(build|run)\b")


def read(path):
    try:
        with open(path, encoding="utf-8") as f:
            return f.read()
    except (OSError, UnicodeDecodeError):
        return ""


def code_only(text):
    """The text without whole-line comments: a script that only names another in a comment does not run it."""
    return "\n".join(line for line in text.splitlines() if not line.lstrip().startswith("#"))


MESSAGE = re.compile(r"\b(echo|printf|refuse|fail|FAIL|WARN)\b")


def commands_only(text):
    """The lines that can run a script: not the ones that print or refuse with a message that names it."""
    return "\n".join(line for line in text.splitlines() if not MESSAGE.search(line))


def repo_files():
    out = {}
    for d, dirs, files in os.walk(ROOT):
        dirs[:] = [x for x in dirs if x not in SKIP_DIRS]
        for name in files:
            if name.endswith((".sh", ".py")) or name == "Dockerfile":
                p = os.path.join(d, name)
                out[os.path.relpath(p, ROOT)] = code_only(read(p))
    return out


def images_in(text, strict_docker):
    """The image names that a text uses as docker arguments."""
    if strict_docker and not DOCKER.search(text):
        return set()
    found = set()
    for line in text.splitlines():
        if line.lstrip().startswith("#") or "grep" in line:
            continue
        for m in USE.finditer(line):
            found.add(m.group(1) or m.group(2))
    return found


FILES = repo_files()
BY_FILE = {p: images_in(t, True) for p, t in FILES.items() if p not in NO_PULL}


def reach(text):
    """Images reached by a text: used by it directly, or by any script it names, and the scripts those name."""
    found = images_in(text, False)
    seen, todo = set(), [p for p in FILES if p not in NO_PULL and p in commands_only(text)]
    while todo:
        p = todo.pop()
        if p in seen:
            continue
        seen.add(p)
        found |= BY_FILE.get(p, set())
        todo += [q for q in FILES if q not in NO_PULL and q not in seen and q in commands_only(FILES[p])]
    return found


def jobs_of(path):
    """(name, [step texts]) for each job; a step starts at a '      - ' line."""
    jobs, name, steps, in_jobs = [], None, [], False
    for line in code_only(read(path)).splitlines():
        if re.match(r"^jobs:\s*$", line):
            in_jobs = True
        elif in_jobs and (m := re.match(r"^  ([A-Za-z0-9_-]+):\s*$", line)):
            if name:
                jobs.append((name, steps))
            name, steps = m.group(1), []
        elif in_jobs and name and re.match(r"^      - ", line):
            steps.append(line + "\n")
        elif in_jobs and name and steps and (line.startswith("        ") or not line.strip()):
            steps[-1] += line + "\n"
    if name:
        jobs.append((name, steps))
    return jobs


def named_images(step):
    m = re.search(r"^\s*images:\s*\"?([A-Z0-9_ ]+)\"?\s*$", step, re.M)
    return set(m.group(1).split()) if m else set()


failures, checked = [], 0
wf_dir = os.path.join(ROOT, ".github", "workflows")
for wf in sorted(os.listdir(wf_dir)):
    if not wf.endswith(".yml"):
        continue
    for job, steps in jobs_of(os.path.join(wf_dir, wf)):
        needs = [reach(s) for s in steps]
        first = next((i for i, n in enumerate(needs) if n), None)
        if first is None:
            continue
        checked += 1
        want = set().union(*needs)
        where = f"{wf} job {job}"
        acts = [i for i, s in enumerate(steps) if "uses: " + ACTION in s]
        checkouts = [i for i, s in enumerate(steps) if "actions/checkout@" in s]
        if not acts:
            failures.append(f"{where}: reaches {sorted(want)} but has no pinned-images step")
            continue
        if acts[0] > first:
            failures.append(f"{where}: the pinned-images step comes after the first step that needs an image")
        if not checkouts or checkouts[0] > acts[0]:
            failures.append(f"{where}: the pinned-images step must come after the checkout (it reads PINS)")
        have = set().union(*(named_images(steps[i]) for i in acts if i <= first))
        if want - have:
            failures.append(f"{where}: the pinned-images step before the first use does not name {sorted(want - have)}")
        if have - want:
            failures.append(f"{where}: the pinned-images step names {sorted(have - want)}, which the job never uses")

for f in failures:
    print("FAIL: " + f, file=sys.stderr)
if failures:
    sys.exit(1)
print(f"ci images: {checked} jobs that use a pinned image all get it from pinned-images first")
