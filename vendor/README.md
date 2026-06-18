# vendor/

Third-party apps the Familiar runs, vendored into the tree so they ship "in the
box" (the same posture as `phylactery/` and `unruh/`, except these are *not* our
code). Their build artifacts and virtualenvs are gitignored; their source is
committed.

## searxng/ (not vendored yet)

The optional Familiar-managed web-search backend. SearXNG is a **rolling
release** — no version tags — so we pin to a specific commit SHA.

```bash
# from the repo root
git clone --depth 1 https://github.com/searxng/searxng vendor/searxng
git -C vendor/searxng rev-parse HEAD > vendor/searxng/VERSION   # the pin
rm -rf vendor/searxng/.git                                       # vendor, don't embed
```

Then pair on the boot smoke-test before trusting the spawn — see
[`docs/searxng-managed-build-spec.md`](../docs/searxng-managed-build-spec.md)
§"Remaining work". Until `vendor/searxng/searx/webapp.py` exists, the managed
backend stays dormant and search runs on the in-box keyless backend.
