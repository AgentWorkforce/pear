# Pear as Desktop Chat Companion — Rebuild Plan

Branch: `chat-companion-rebuild` (off `main` @ `6ab8e76`).
Goal: Pear stops rendering terminals and stops using any PTY. It becomes a
desktop chat companion to the Relay iOS app (`AgentWorkforce/relay-app`,
`ipad/native/Sources`), backed directly by Agent Relay. It must read as a
different product from the Relay Mac app (`relay-desktop`), not a copy.

## 1. What gets removed (verified in this checkout)

Renderer (`src/renderer/src`):

- `components/terminal/TerminalInstance.tsx`, `TerminalPane.tsx`,
  `PendingMessagesPane.tsx`
- `lib/terminal-runtime-registry.ts` (xterm owner: Terminal, FitAddon,
  WebLinksAddon, WebglAddon), `lib/echo-router.ts`,
  `lib/predictive-echo.ts` (imports `Terminal` + `PredictiveEchoEngine`
  from `@agent-relay/harness-driver`), `lib/terminal-reconciler.ts`,
  `lib/pty-size-sync.ts`, `lib/font-settle.ts`
- `stores/pty-buffer-store.ts`, `hooks/use-terminal.ts`,
  `__test__/xterm-mock.ts`
- Trim only the PTY branch of `hooks/use-broker-events.ts`
  (`onPtyChunk` / `appendPtyChunk` / typing marks)

Main (`src/main`): `pty-dedup.ts`, `pty-input-stream.ts`,
`pear-fleet-node.ts` (local `StaticPtyHarnessDefinition`s), 
`term-fidelity-corpus.ts`. Trim `broker.ts` (`attachTerminal`,
`sendInput`/`sendInputFast`, `setTerminalMode`, `resizePty`,
`snapshotTerminal`, worker `pty-chunk` fast path) and the `spawnPty`
normalization in `spawn-coordinator.ts`.

IPC bridge: `BrokerAttachTerminalInput/Result`, `BrokerTerminalSnapshot`,
`TerminalAttachMode`, and the `pear.broker.attachTerminal`,
`sendInput*`, `setTerminalMode`, `resizePty`, `snapshotTerminal`,
`inputSrtt`, `onPtyChunk` surface in `shared/types/ipc.ts`,
`main/ipc-handlers.ts`, `preload/index.ts`.

Deps: `@xterm/xterm`, `@xterm/addon-fit`, `@xterm/addon-web-links`,
`@xterm/addon-webgl`, devDep `@xterm/headless`, and the
`@agent-relay/harness-driver` predictive-echo import.

Tests: `tests/playwright/{rendering-corruption,fidelity-no-duplication,
terminal-focus-stacking,redraw-drain,stress-1000-agents}.spec.ts` and
`tests/term-fidelity/*`. Nothing is left as dead code: after deletion, grep
for `xterm`, `pty`, `attachTerminal`, `sendInput`, `resizePty` must be clean
(apart from historical docs).

Kept as-is: `auth.ts`, `store.ts`, `integrations*`,
`relay-workspace` / `relay-service-urls`, `cloud-agent*`,
`proactive-agent*`, `broker-binary` / `event-history` /
`observer-stream`, `burn*`, `git` / `filesystem`, updater / CLI /
avatar-cache, and the renderer shell (`App.tsx`, sidebar) plus the
non-terminal surfaces (`chat`, `diff`, `issues`, `agents`, `settings`).

## 2. New chat architecture

Direct Cloud/Relaycast API client in the main process — no local daemon,
no socket bridge:

- New `src/main/relay-chat-client.ts`: fetch wrapper against the Relaycast
  base + `/v1`, Bearer `workspaceKey` for roster calls and `agentToken`
  (`at_live_…`) for agent calls, 3x retry on 503 `database_overloaded`,
  workspace-key rotation via `/workspaces/{id}/resolve` on 401.
- Poll scheduler in main: 30s `refresh()` (roster + nodes //
  pollMessages // pollChannels), refresh on foreground, `loadHistory` on
  open. Channel history reloads on open/foreground/push, not on the loop.
  Poll-only in v1 (no desktop push registration yet).
- New `chat.*` IPC bridge (`chat.listConversations`, `chat.getHistory`,
  `chat.send`, `chat.markRead`, `chat.joinChannel`, `chat.uploadFile`,
  plus `chat:invalidated` / `chat:message` events) in
  `shared/types/ipc.ts`, `main/ipc-handlers.ts`, `preload/index.ts`.
- New renderer surface `components/chat-desktop/`: `ConversationList.tsx`
  (Agents / Messages / Channels tabs, search + machine filter, pin/hide,
  unread dot, 5-minute reachable dot), `ThreadView.tsx` (day dividers,
  15-minute groups, mine-right / theirs-left, channel sender labels, link
  detection, attachment download, delivery label under last own message,
  optimistic pending with tap-to-edit on failure, auto-scroll),
  `Composer.tsx` (attachments, multiline, disabled-when-empty, optimistic
  send then refresh + `loadHistory`). State in `stores/chat-store.ts`.
- Task/thread-first home: Pear opens on tasks, threads, and approvals it
  owns — never a machine session table, never a generic @name DM browser.

## 3. How it maps to the iOS app's chat

Types mirror `RelayClient.swift`: `RelayMessage` (`id` with
row-index fallback, `text`, `agent_name` sender, `mine`, ISO8601
`created_at`, `attachments[]`), `RelayAgent` (id prefixes
`relay:|drive:|conversation:|channel:`, name@host machine, session
title/objective/cli, status
active/online/waiting/blocked/idle, human vs agent, channel
memberCount/isJoined). Endpoints map 1:1: `GET /agents?status=all`,
`GET /nodes`, `GET /dm/conversations`, `GET/POST` channel + DM message
routes with `?limit=100` history reversed oldest-first, `POST /dm`,
readers-based delivery, and the upload/complete file flow. Like iOS, chat
has no typing indicator and no message streaming — polling plus
per-open history. The iOS-only pieces stay out: `RelayTerminal.swift`
WebSocket terminal attach and the voice-call WebRTC path.

## 4. How it differs from the Mac app (relay-desktop)

1. No upload manager: no session census, sharing modes, upload queue, or
   collector diagnostics. Cloud ingestion is assumed.
2. No local-daemon thin client: no `core.sock` bridge, no LaunchAgent
   lifecycle, no generated CoreContract. Pear calls Cloud/Relaycast
   directly with its own auth.
3. Task/thread-first home, not the local-sessions table.
4. Narrow scope: one job (spawn-and-supervise / approval triage),
   deep-links out for the rest — no per-provider pages or hook installers.
5. Single-purpose window, not full companion chrome (no onboarding
   chooser, provider setup, settings panes, tray replica, self-update).
6. Messages only inside Pear-owned task/run/approval context with inline
   delivery — no universal Message-an-Agent sheet, no roster browser, no
   second Skip assistant.

## 5. Build order + tests

1. Delete §1; `tsc`, `eslint`, remaining vitest green.
2. Scaffold `relay-chat-client.ts` (+ auth reuse) with fixture tests for
   503-retry / 401-rotation / attachment-upload sequence.
3. `chat.*` IPC + preload + types; unit IPC round-trip test.
4. `chat-store` + `ConversationList` DOM tests (unread / reachable /
   pin-hide / search).
5. `ThreadView` + `Composer` DOM tests (optimistic pending, failure edit,
   readers delivery label, day dividers).
6. Poll wiring + Playwright send→appears / second-client-received /
   readers→delivered.
7. Attachments end-to-end + slim packaging smoke
   (start, sign-in, list, open, send, join, offline-error).
