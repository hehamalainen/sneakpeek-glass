# SneakPeek Glass

Review a coding agent’s permission request from a 600 × 600 display. See which project is waiting, deny the action, send it back to the host, or approve a narrowly scoped read. This prototype grew out of a conversation at an AI event in Helsinki.

[Watch the 17-second simulator demo](docs/simulator-demo.mp4). Two sample requests pass through the local relay: the wearer approves a README read and denies a Git push. The footage was recorded in Meta’s Chrome simulator.

![Concept view of the Helsinki prototype](docs/sneakpeek-glass-pov.png)

*Concept view.* The original sketch shows a Git push. The reviewed build requires terminal approval for every shell command, including that push.

## Try it on a Mac

Use Node 18 or newer. The relay, hook, and unit tests use Node’s standard library. Run these commands in a shell in the checkout. Keep that shell open for your agent.

```sh
npm test
export SNEAKPEEK_TOKEN="$(openssl rand -hex 24)"
pair_code="$(openssl rand -hex 24)"
printf 'Pairing suffix (valid for 10 minutes): #pair=%s\n' "$pair_code"
SNEAKPEEK_PAIR_CODE="$pair_code" node relay/relay.mjs &
unset pair_code
```

For a desktop preview, append the printed suffix to `http://127.0.0.1:8787/` and open the resulting address in a browser. For Meta Ray-Ban Display, route a trusted HTTPS tunnel to the same loopback port. For example, run `cloudflared tunnel --url http://127.0.0.1:8787` in another terminal. Append the suffix to its HTTPS address and use **Add a Web App** in the Meta AI app’s developer settings. The code pairs one browser per relay start, so choose the glasses or the desktop for each run. [Meta’s setup guidance](https://developers.meta.com/wearables/faq/)

To try the simulated display, open the paired desktop preview in Chrome and click the [Meta Ray-Ban Display Simulator](https://chromewebstore.google.com/detail/meta-ray-ban-display-simu/jpjlmmodokemlepklkdbimceggpbjcll) extension. Use the arrow keys to move focus and Enter to select. The smoke command below supplies a sample permission request.

### Connect your agent

Choose the example for your host. Merge it into the indicated file, set the hook command to the absolute script path in your trusted checkout, and start the agent with the same `SNEAKPEEK_TOKEN` as the relay. The relay and hook run on the same Mac. A desktop app launched separately may need its launcher configured to pass the submit token.

| Host | Configuration | Lens decisions |
| --- | --- | --- |
| Claude Code | [Example](hook/settings.example.json) → `~/.claude/settings.json` | Approve eligible reads, deny, or return to the permission dialog. |
| Codex CLI / app-server | [Example](hook/codex.example.json) → `~/.codex/hooks.json`. Review and trust the new hook via `/hooks`. | Deny or defer a native approval request. Shell escalations, patches and external tools require approval in Codex. |
| Antigravity | [Example](hook/antigravity.example.json) → `.agents/hooks.json` in the target workspace | Approve an eligible single-file read, deny a matched tool, or request host review. The adapter uses the single-workspace context. |
| GitHub Copilot CLI | [Example](hook/copilot.example.json) → `~/.copilot/hooks/sneakpeek.json` | Deny, request a host prompt, or continue a bounded read through Copilot’s own permission policy. |

Claude and Codex use `PermissionRequest`. Already-permitted operations generally produce no card. The Antigravity and Copilot examples use pre-tool hooks for selected tools, so a card can appear before the host evaluates its own permissions. Their host button requests a native prompt. In a noninteractive session, the host may deny instead. [Claude Code](https://code.claude.com/docs/en/hooks#permissionrequest) · [Codex](https://developers.openai.com/codex/hooks) · [Antigravity](https://antigravity.google/docs/hooks) · [GitHub Copilot CLI](https://docs.github.com/en/copilot/reference/hooks-reference)

To exercise the entire flow without sending a model prompt, run this from the checkout while the paired browser is open. Select Approve twice and the command prints the one-time hook decision.

```sh
node -e 'console.log(JSON.stringify({hook_event_name:"PermissionRequest", session_id:"demo", cwd:process.cwd(), tool_name:"Read", tool_input:{file_path:process.cwd()+"/README.md"}}))' | node hook/sneakpeek-hook.mjs
```

## What can you approve?

<img src="docs/lens-preview.png" alt="Browser capture showing a Claude Code request to read README.md, with Terminal focused" width="400">

*Desktop browser capture at 600 × 600 from the automated interaction test.*

The display starts with **Terminal** or **Host** focused. Use left or right to choose an action. Two separate activations within three seconds approve the current request. Moving focus cancels confirmation.

The Claude adapter permits a file-name search in the working directory using one of six exact patterns (`*.md`, `*.js`, `*.mjs`, `*.ts`, `*.py`, `*.json`) or a plain Read of a regular top-level `README.md`, `CHANGELOG.md`, or `LICENSE`. Additional arguments or a symlinked document require terminal review. Both the hook and relay check eligibility. A read can disclose a document’s contents to the agent. Use a trusted workspace and a trusted hook installation.

For shell commands, writes and external tools that reach the lens, the available actions are Deny and Terminal or Host. Long previews show both ends and an omission count. The card identifies the host, project and session. The hook discards transcript text and write contents.

## Connection and privacy

The hook talks to a relay on the same Mac. A submit token can queue requests. The paired browser holds a separate decision token in same-origin local storage. Reloading the page restores the pairing. Restarting the relay revokes the browser token, drops pending requests, and requires a fresh pairing code. The HTTPS tunnel provider can see request previews and authenticated traffic. Treat the pairing link as private.

The browser polls every 1.5 seconds while visible. With no recent viewer, the relay immediately defers a new request. If the viewer disconnects, outstanding requests defer after about 10–11 seconds. Otherwise the relay waits up to 110 seconds, the hook waits 115 seconds, and the host hook configuration allows 120. On failure, the adapter delegates to the host’s normal policy. A noninteractive host may deny the request.

The relay writes decision metadata as JSON lines to stdout. Each entry records time, request ID, project, tool, session tag, and decision source. For a local record, redirect the relay’s stdout to a private log. Anyone with the paired browser credential can act as that viewer. The queue holds four requests per session and 32 overall.

## Verification

Run `npm test` for the relay and hook process tests. With Chrome installed, run `npm ci` and `npm run test:browser` on Node 20+ for the 600 × 600 interaction test. GitHub Actions runs both suites.

The installed clients were exercised on macOS using loopback model fixtures and scratch projects. Claude Code 2.1.98 read a fixture document after approval. Codex CLI 0.144.5 (app-server) returned the lens denial for a shell escalation. Antigravity CLI 1.5.6 blocked a command and read a fixture document after approval. GitHub Copilot CLI 1.0.93-1 returned the lens denial for a shell tool. The desktop IDEs and Copilot cloud agent were outside those runs.

For an on-device trial, pair a fresh relay with the glasses, run the README smoke command, and verify that two separate pinches produce one approval. Then deny a shell request, close the app during a pending request, and confirm that the host regains control. Record the glasses and phone software versions with the outcome.

The app targets the display model. Physical gesture timing, phone tethering, pairing-link handling, readability in daylight, and battery use still need an on-device trial. Keep the app in the foreground during a trial. [Meta Web Apps](https://developers.meta.com/wearables/web-apps/)

## License

The source code is available under the [MIT License](LICENSE).
