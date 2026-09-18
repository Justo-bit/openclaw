---
summary: "Watch or control a desktop-capable cloud worker from the Control UI"
title: "Cloud Worker Desktop"
read_when: "You want to observe or drive a cloud worker's desktop, or you are enabling the desktop lab."
---

Enable an interactive desktop on a Crabbox profile and connect through its authenticated cloud node.

## Desktop (interactive)

Cloud Worker Desktop lets an administrator watch or control a capable worker from the Control UI without exposing its cloud node as an ordinary paired node. Enable the **Cloud Worker Desktop** lab, then set `settings.desktop: true` on a Linux, prepared macOS, or native Windows Crabbox profile. Select `windows/normal` for Windows; WSL2 desktops are unsupported. Desktop capability is fixed at warm time: changing the setting affects newly provisioned workers, while an existing non-desktop lease must be stopped and reprovisioned. Warm-image capture remains Linux only.

The bundled Crabbox plugin supports direct AWS and Azure profiles. Coordinator-backed AWS, Azure, and Hetzner profiles are supported when the selected coordinator advertises Desktop and Browser capability. OpenClaw keeps worker execution node-only: `openclaw worker`, workspace transfer, desktop observation, and app launch all use the authenticated outbound node connection. It does not restore SSH execution, a reverse tunnel, or rsync. Direct Hetzner rejects OpenClaw's fixed lease ID, so desktop profiles fail before allocation unless Hetzner uses a capable managed coordinator.

Each node connects to its desktop's authenticated RFB server through `127.0.0.1:5900`. The desktop also has a browser with loopback CDP on port `9222` and provider-owned Browser and Terminal launchers. OpenClaw installs a worker wallpaper so the disposable desktop is easy to identify. Setup is idempotent and completes before the cloud desktop becomes available, including on provisioning replay. Project image preparation keeps desktop setup before project setup and capture.

Linux uses Crabbox's XFCE session on display `:99`. Native Windows uses Crabbox's interactive-session launcher so the enrolled node and CUA run as the desktop user, with the same account and session checked on replay. macOS uses the dedicated signed **OpenClaw Cloud Worker** app to host CUA and the enrolled node in the worker account's GUI session; see the image prerequisites below.

A vision-capable agent whose tool policy permits `computer` controls this desktop through the session's exact placement; it cannot select another node. This works for both OpenClaw workers and Codex remote execution. See [Desktop and computer control](/gateway/cloud-sessions#desktop-and-computer-control) for tool enablement and manual-control guidance.

The desktop never gains public ingress. The node reads the lease's password file locally, inspects the loopback RFB security offer, and keeps that same connection for the viewer. Linux and Windows use VNC password authentication. macOS uses Apple Remote Desktop account authentication with the inspected worker username and a private copy of Crabbox's managed password. These credentials pass transiently through the authenticated node connection for preauthentication; the viewer does not enter the worker password. The node redeems a single-use Gateway broker ticket over its already-connected origin. Opening viewers therefore creates no extra unauthenticated probe connections. TLS deployments pin the same Gateway certificate used by the node connection. The Gateway revalidates the durable environment, lease, node, owner epoch, desktop descriptor, connection, and pairing both before dispatch and after attach; drain, replacement, or teardown aborts the stream and any pending app launch. The shared desktop session owner performs RFB preauthentication, view-only input filtering, and single-controller arbitration. Browser protocol negotiation overlaps worker authentication, but authentication success and desktop traffic wait for both sides to finish.

An open chat updates its desktop target when committed session placement events arrive, including worker replacement and teardown, without waiting for a sidebar refresh.

Closing the requesting Gateway connection cancels pending viewer setup and unclaimed node streams, freeing their observer slots without waiting for ticket expiry. Other connected viewers retain their streams.

If you close or replace a Desktop panel during setup, it releases the unused observation when setup returns. This frees that attempt's node stream and viewer slot without waiting for ticket expiry or interrupting another viewer. A connected viewer retains the existing brief-hide behavior.

The Gateway sends WebSocket keepalives on desktop observer and node desktop or portal streams while idle, so an unchanged screen or quiet preview does not go silent behind a proxy. Backpressure may delay pong replies without revoking the stream; the owning session and control connection still govern teardown.

When another operator takes control, your viewer reconnects in view-only mode. The notice identifies the new controller by their authenticated profile name, or their authenticated user ID when no profile name is set. Connections without an authenticated user identity show a generic takeover notice.

## macOS image prerequisites

Prepare a macOS 15 or later worker image with `/Applications/OpenClawCloudWorker.app`, signed with a Developer ID Application identity and containing its bundled CUA driver. Build the dedicated app from a source checkout on macOS:

```bash
OPENCLAW_MAC_CLOUD_WORKER_HOST=1 scripts/package-mac-app.sh
```

Install the resulting `dist/OpenClawCloudWorker.app` in the image. Grant **OpenClaw Cloud Worker** Accessibility and Screen Recording access for the intended worker account, install Google Chrome, and sign in to an unlocked desktop. The cloud app has its own bundle identity and permission grants, separate from the ordinary OpenClaw app. Provisioning verifies the signed cloud-host capability before starting it; an older or ordinary app does not satisfy this requirement.

Keep Crabbox's passwordless `sudo` access enabled for the worker account. Desktop launch uses it to enter the GUI session, then runs the app, browser, and terminal as that worker account.

The app owns both CUA and the ephemeral cloud node. It stops the node before retiring CUA if its desktop session or daemon becomes unavailable. Reprovision an unavailable desktop after restoring the image prerequisites. Existing cloud placement, enrollment, and teardown owners continue to govern the lease.

AWS macOS requires an available EC2 Mac Dedicated Host and On-Demand allocation. Configure the prepared image and host selection through Crabbox on the Gateway host. Crabbox does not allocate a new Dedicated Host implicitly. See [Crabbox provider support](/gateway/cloud-workers#coordinator-backed-crabbox).

## Native Windows prerequisites

Use a managed Windows desktop image with Crabbox's **CrabboxDesktopLauncher** service and an active desktop for the configured worker account. Desktop enrollment runs inside that interactive session; the ordinary detached SSH launcher remains the path for headless Windows workers. A Session 0 process or a process belonging to another account cannot satisfy desktop enrollment replay. See [Windows runtime prerequisites](/gateway/cloud-workers/setup-and-bundle-installation#native-windows-prerequisites).

Workspaces containing symbolic links require Windows Developer Mode in the image or the **Create symbolic links** privilege for the interactive account.

## Desktop size

Open **Systems** in the Control UI sidebar to select a worker and use its desktop
as the main workspace. The docked and chat-side Desktop panels remain available;
all presentations reuse the desktop connection implementation and Gateway control arbitration.

The **Desktop size** menu is available in the panel and the standalone desktop view:

- **Fit** is the default. It scales the existing framebuffer to the viewer without changing the worker's display resolution.
- **Actual** shows the framebuffer without local scaling or remote resizing.
- **Match** requests the viewer's dimensions as the worker's display resolution. It also scales locally while the request is pending or unsupported.

Match appears only after a controlling connection authenticates and the worker provider permits virtual-display resizing. View-only connections cannot request resizing. Direct host desktops do not gain this permission.

The Crabbox plugin permits requests for its dedicated worker desktops. This permission does not prove server support. Match requires a VNC server that negotiates desktop resizing, such as Crabbox's dynamic Linux TigerVNC desktop. Fixed-size servers, including native platform servers without that extension, remain usable with Fit and Actual. To resize older Linux Xvfb/x11vnc workers, update Crabbox to a build with dynamic XFCE support and reprovision the desktop worker. Changing the menu alone does not upgrade an existing worker.

A controlled reconnect to the same source retains the sizing choice. Changing sources resets it to Fit. Losing control or resize permission also resets Match to Fit.
