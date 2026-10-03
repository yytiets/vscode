# Canvas Support in the Agents and Editor Windows

## Status

The implementation is being rebased onto `origin/main` at
`d7622a529314a4abcefd7ca9e3d7344bc9ccba9e`.

The original investigation used `faf5ab10523709dc2fd6bc7d6d19888cdc48c764`.
Upstream subsequently replaced the VS Code-specific canvas facade with
experimental AHP canvas channels in #337780. This document now describes that
channel-based implementation, rather than proposing restoration of the removed
facade.

## Agreed scope

- Desktop Agents and regular Editor windows.
- The same local Copilot SDK/Agent Host sessions supported by the Agents window.
- In the Editor window, an exact canvas owner remains eligible whenever its chat
  is visible, including split chats. Focus is not ownership.
- Preserve the Agents window's active-session/active-chat policy.
- Use ordinary editor tabs and the existing private native-browser primitive.

Not in this version: standard extension-backed Copilot Chat, web rendering,
remote canvas transport, ephemeral/subagent canvas runtime support, persistent
canvas tabs, or auxiliary-window native hosting.

## 1. Current protocol and runtime

The authority is the experimental AHP channel model:

```text
Copilot SDK canvas events
  -> Agent Host canvas channels and chat membership
  -> ChatState.canvases: advertised resource references
  -> subscriptions to the exact advertised CanvasState resources
  -> provider-neutral live descriptors
  -> window-specific ownership and placement adapters
  -> shared canvas coordinator and editor
  -> unlisted, ephemeral native browser view
```

See [chat state](./src/vs/platform/agentHost/common/state/protocol/channels-chat/state.ts),
[canvas state](./src/vs/platform/agentHost/common/state/protocol/channels-canvas/state.ts),
and [subscription handling](./src/vs/platform/agentHost/common/state/agentSubscription.ts).

Important differences from the original investigation:

1. There is no `IAgentConnection.canvases` facade or separate source-resolution RPC.
2. Membership comes from the owning chat; canvas state is independently subscribable.
3. A canvas resource identifies a live lifetime. Metadata/source changes do not
   constitute a new open and must not undo dismissal.
4. A descriptor exposes the current optional HTTP(S) source, not a revision-based
   resolver.
5. Unknown chat membership is distinct from an authoritative empty collection.
6. Canvas state may be pending or unavailable while its resource remains present.
7. Live source URLs must be excluded from persistence and redacted from diagnostics.

The runtime still owns extension discovery and lifecycle. The integration does
not add SDK tools, dependencies, permission bypasses, or a public extension API.

## 2. Shared capability and layer ownership

[The workbench canvas contribution](./src/vs/workbench/contrib/canvases/) owns:

- [common descriptors, context contracts, and the editor input](./src/vs/workbench/contrib/canvases/common/canvas.ts);
- [Agent Host channel projection](./src/vs/workbench/contrib/canvases/common/agentHostCanvas.ts);
- [presentation coordination](./src/vs/workbench/contrib/canvases/electron-browser/canvasService.ts);
- [the native pane and accessible content](./src/vs/workbench/contrib/canvases/electron-browser/canvasEditor.ts);
- [shared registrations](./src/vs/workbench/contrib/canvases/electron-browser/canvases.contribution.ts).

`vs/sessions` may import this shared capability; the workbench must never import
Sessions code. Native registrations load through the respective desktop entry
points, not common/web entry points.

Historical editor/input IDs, the `session-canvas` resource scheme, focus context,
and accessibility provider/verbosity IDs remain unchanged. Moving implementation
ownership does not require a persistence or identifier migration.

## 3. Provider projection and Editor model bridge

[AgentHostCanvas](./src/vs/workbench/contrib/canvases/common/agentHostCanvas.ts)
projects an advertised channel and its optional state into:

- stable resource identity;
- optional hydrated instance ID;
- display title/status;
- optional validated live HTTP(S) source.

The source parser accepts only absolute HTTP(S) URIs with an authority and logs
generic invalid-source messages without including the source or exception text.
Never decode a host's canvas URI to guess its owner. The owning chat supplies
membership, and the resource is passed unchanged to the subscription API.

The [Sessions provider](./src/vs/sessions/contrib/providers/agentHost/browser/baseAgentHostSessionsProvider.ts)
retains upstream's active-session subscription model and uses the shared
descriptor projection.

The Editor bridge is:

```text
AgentHostChatSession.canvasContext
  -> IChatSession.canvasContext
  -> IStartSessionProps
  -> ChatService
  -> ChatModel.canvasContext
```

See [the provider](./src/vs/workbench/contrib/chat/browser/agentSessions/agentHost/agentHostSessionHandler.ts),
[the internal session contract](./src/vs/workbench/contrib/chat/common/chatSessionsService.ts),
[model construction properties](./src/vs/workbench/contrib/chat/common/model/chatModelStore.ts),
[ChatService](./src/vs/workbench/contrib/chat/common/chatService/chatServiceImpl.ts),
and [ChatModel](./src/vs/workbench/contrib/chat/common/model/chatModel.ts).

The provider publishes a live observable immediately, even before first-turn
materialization confirms a chat. It derives identity from the handler's backend
binding and actual subscribed chat state, including peer chats.

Canvas channel subscriptions:

- are lazy and refcounted;
- follow advertised membership and channel-state updates;
- release when references disappear or observation ends;
- rebind with connection initialization;
- do not hydrate unrelated background sessions or retain a chat model solely for
  a hidden canvas.

Unsupported providers omit the bridge. Local registration explicitly enables
presentation only for the supported Copilot provider; a remote ambient bridge
does not qualify just because its connection authority is named `local`.

Canvas context is live UI metadata. It is not included in transcript history,
serialized model data, operation logs, transferred persisted state, or model input.

## 4. Window policies

### Agents window

[The Sessions adapter](./src/vs/sessions/contrib/canvases/electron-browser/sessionCanvasService.ts)
uses the existing active session, active chat, and provider capabilities. It
supplies the single main editor group's placement and authoritative session
removal notifications.

[Desktop Details classification](./src/vs/sessions/contrib/layout/browser/desktop/desktopSharedHelpers.ts)
recognizes the shared input so the canvas retains its full editor presentation.

### Editor window

[The Editor adapter](./src/vs/workbench/contrib/canvases/electron-browser/editorCanvasContextService.ts)
observes actual chat widgets, their model bindings, and visibility. It deduplicates
multiple presentations of an exact owner and supports independently visible owners.

- A focused canvas or file does not invalidate a visible owning chat.
- A hidden chat-editor tab does not qualify as a visible owner.
- Switching a widget to another chat removes only that widget's ownership claim.
- Ordinary widget backgrounding/provider unbinding is not backend deletion and
  must not reset a user dismissal.
- Authoritative empty membership or explicit session deletion performs cleanup.

### Placement

Open through `IEditorService`.

1. Reveal the same input in its existing safe group.
2. Prefer an existing non-owner main-window group.
3. Reuse the established canvas group for subsequent instances.
4. If necessary, create one adjacent group relative to the actual owner.

Do not replace the originating chat editor, hide another visible owning chat, or
interpret side-group placement relative to an unrelated active group.

The design goals are **Focused** and **Consistent**: keep the conversation and
canvas co-visible and use ordinary editor conventions. Preserve the pane's
**Calm** chrome rather than adding an address bar or a second panel system.

## 5. Lifecycle contract

| Event | Presentation behavior |
| --- | --- |
| New lifetime with a live source and visible owner | Open/reveal one pinned input. |
| New lifetime while the owner is hidden | Do not reveal or steal focus. |
| Same resource, changed metadata/source | Update the input/current page without repeated auto-reveal. |
| User closes the tab | Dismiss that lifetime locally; do not call SDK close or extension `onClose`. |
| Agent opens a new lifetime | Permit a new reveal, even for the same instance ID. |
| Unknown membership | Retain input/dismissal bookkeeping; do not treat it as removal. |
| Pending/unavailable source | Retain the resource and show the unavailable placeholder. |
| Authoritative resource removal | Close the input and forget its dismissal/presentation state. |
| Owner becomes ineligible | Detach its native content without substituting another owner. |
| Setting/AI availability disabled | Close presentation and stop native source loading. |
| Async native creation finishes after input/source/owner changed | Dispose the stale model exactly once. |
| Editor open fails | Report failure and do not permanently mark the lifetime presented. |

Source changes are fenced by source identity and load sequence, not removed
provider revision numbers. Hidden panes must remain hidden after resize, zoom, or
scheduled layout even when their old rectangle is still non-empty.

The initial reveal retains existing options:
`pinned: true`, `revealIfOpened: true`, `preserveFocus: false`.

Input identity never contains a source URL. Inputs have no serializer and cannot
be reopened from closed-editor history. A still-running host's live channel state
is different from resurrecting source URLs after a host/provider restart.

## 6. Native privacy, accessibility, and window boundaries

Use [createExternalBrowserView](./src/vs/workbench/contrib/browserView/electron-browser/browserViewWorkbenchService.ts):
an unlisted, user-owned view with ephemeral storage and no initial agent audiences.
Canvas pages must not become ordinary agent-shared browser tabs.

Retain [WebContentsViewHost](./src/vs/workbench/contrib/browserView/electron-browser/webContentsViewHost.ts)
for native focus, overlap detection, screenshots, and visibility. CSS stacking
cannot place workbench overlays above an Electron native view.

Both windows reuse Accessibility Help, plain-text Accessible View, the existing
verbosity setting, keyboard exit, and valid focus restoration. Native content
visibility requires eligible ownership, a live source, actual pane visibility,
on-screen bounds, and a supported host window.

Auxiliary hosting remains explicitly unsupported: reject cross-window movement
with the standard input veto and reject direct opens before loading a source.
`Singleton` alone is not a window boundary.

## 7. Validation

The focused suites cover:

- channel identity and unknown/pending state;
- advertised opaque resource references and subscription disposal;
- source validation without diagnostic leakage;
- first-turn and exact peer-chat projection;
- provider/model context forwarding without serialization;
- split-owner visibility and owner-preserving placement;
- lifetime dismissal, hydration, source updates, and removal;
- cancelled/failed editor opens and stale native creation;
- native visibility and auxiliary-window rejection;
- unchanged Agents Details presentation and setting/AI gates.

After adaptation to the fetched main:

- `npm run typecheck-client`: passed.
- Uncached repository ESLint on the conflict-resolution/protocol surfaces: passed.
- Focused canvas, provider, model, pane, and layout tests: 40 passed.

Before completing the rebase verification, also run the import-layer checker,
related chat/protocol regressions, and a fresh full Code OSS build after restoring
changed dependencies as necessary.

The earlier
[synthetic native Editor report](./.build/vscode-playwright-mcp/evidence/canvas-editor-native-2026-10-03T19-46-44-708Z/report.html)
passed four steps on macOS arm64, Code OSS 1.141.0 Dev, **before the rebase**.
It is historical UI evidence, not proof of the current protocol integration.

Remaining real-OSS verification:

1. Launch isolated, authenticated profiles with the actual Copilot SDK and a safe
   project canvas extension.
2. In the Editor window, use the runtime tools to discover/open the canvas,
   interact with its page, invoke an action, close/reopen, and switch owners.
3. Repeat opening, interaction, dismissal/reopen, and active-owner gating in the
   Agents window.
4. Record observable state and screenshots. Report sign-in/platform/tooling
   blockers as unverified, never as passing tests.

Windows/Linux native behavior and manual assistive-technology checks remain
separate follow-up validation.
