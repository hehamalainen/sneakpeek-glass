# SneakPeek Glass

Approve, deny or defer coding-agent actions from the Meta Ray-Ban Display lens, with a pinch on the Neural Band.

```
Claude Code ──PermissionRequest hook──▶ relay (your Mac, HTTPS tunnel) ◀──poll── Web App on glasses
     ▲                                        │                                   │ Neural Band:
     └──── allow / deny / (nothing = terminal) ◀─────────── decision ◀────────────┘ arrows + Enter
```

## Safety model (the actual research question)
- **Fail-safe.** If the relay is down, times out, or you pick *Terminal*, the hook prints nothing and Claude Code shows its normal dialog. The glasses can only make prompts go away sooner, never add new auto-approvals.
- **Risk tiers** (`relay/risk.mjs`). A **high** risk action (force push, `rm -rf`, secrets, terraform apply, publish…) can't be approved from the glasses, and the relay enforces this on the server, not only in the UI.
- **No accidental yes.** Focus starts on *Terminal*. *Approve* needs two activations within 3 s.
- **Token auth** on every API call. The relay refuses to start without a 16+ character token.

## Run it tonight (about 20 min)
```bash
# 1. Relay on your Mac
cd ~/sneakpeek-glass
export SNEAKPEEK_TOKEN=$(openssl rand -hex 24)
node relay/relay.mjs                      # :8787

# 2. Public HTTPS (the glasses require a valid TLS certificate)
cloudflared tunnel --url http://localhost:8787   # or ngrok http 8787
# -> https://<random>.trycloudflare.com

# 3. Hook into Claude Code
export SNEAKPEEK_URL=https://<random>.trycloudflare.com   # put both vars in your shell profile
# merge hook/settings.example.json into ~/.claude/settings.json

# 4. Glasses: load the Web App by URL (see Meta's Web Apps "Setup" docs)
https://<random>.trycloudflare.com/?t=<SNEAKPEEK_TOKEN>
# You only need the token in the URL once; after that it's kept in localStorage.
```
Smoke test without glasses: open the same URL in a desktop browser sized to 600×600, then start a Claude Code task that triggers a permission prompt.

## Check these against current docs
1. **Hook event.** Uses `PermissionRequest` (fires only when Claude Code would ask you). If your Claude Code version doesn't have it, switch to `PreToolUse` with `permissionDecision: allow|deny|ask` and a matcher such as `Bash|Write|Edit`.
2. **Hook timeout.** Set to 120 s; the relay holds a request for 110 s and then defers to the terminal.
3. **Networking on the glasses.** WebSocket and SSE support isn't documented, so the app polls every 1.5 s. Upgrade to SSE once you've confirmed it works.

## Next lanes
- **SneakPeek adapter.** Have the macOS app POST its own intervention events to `/api/requests`. The relay only needs `project, tool, summary, intent`.
- **Codex / Copilot adapters.** Same payload, different hook.
- **Taste on the band.** Add a fourth action, "feels off", that doesn't block the agent but tags the session for SneakPeek's Taste signal.
- **Swarm mode.** The queue is already multi-session. Add per-project grouping and "approve all similar in this session for 10 min" (a leased trust window).
