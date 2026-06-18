# vendor/

Third-party apps the Familiar runs, vendored into the tree so they ship "in the
box" (the same posture as `phylactery/` and `unruh/`, except these are *not* our
code). Their build artifacts and virtualenvs are gitignored; their source is
committed.

## searxng/ (not vendored yet)

The optional Familiar-managed web-search backend. SearXNG is a **rolling
release** — no version tags — so we pin to a specific commit SHA.

```bash
# from the repo root (any OS)
git clone --depth 1 https://github.com/searxng/searxng vendor/searxng
git -C vendor/searxng rev-parse HEAD > vendor/searxng/VERSION   # the pin
```

Then strip the nested `.git` so it's vendored files, not an embedded gitlink:

```bash
rm -rf vendor/searxng/.git                       # macOS / Linux
```
```powershell
Remove-Item -Recurse -Force vendor\searxng\.git  # Windows PowerShell
```
```cmd
rmdir /s /q vendor\searxng\.git                  :: Windows cmd
```

`git status` should then show the SearXNG files as new untracked files under
`vendor/searxng/`, not a single embedded-repo entry.

Then pair on the boot smoke-test before trusting the spawn — see
[`docs/searxng-managed-build-spec.md`](../docs/searxng-managed-build-spec.md)
§"Remaining work". Until `vendor/searxng/searx/webapp.py` exists, the managed
backend stays dormant and search runs on the in-box keyless backend.
