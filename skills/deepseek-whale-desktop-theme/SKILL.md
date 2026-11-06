---
name: deepseek-whale-desktop-theme
description: "Use when installing, restoring, verifying, updating, or removing the verified Douyin-style DeepSeek desktop look: the original whale-fantasy animated skin, the pinned dsh-boot-animation startup clip, and the matching lower-left intro control icons. Also matches requests for DeepSeek 桌面主题皮肤、启动动画、动态桌面或挂件。"
---

# DeepSeek Whale Desktop Theme

Reproduce the verified desktop appearance as one coordinated setup. Load `cordis-plugin-development` before changing the current profile, and use `cordis_inspect_list` plus targeted `cordis_inspect_query` calls before relying on live plugin APIs or UI slots.

## Verified target state

| Layer | Required state |
| --- | --- |
| Skin renderer | `@linxin666/dsh-client-ui-skin-center@0.4.15` |
| Desktop skin | `whale-fantasy` 1.0.0, “鲸鱼娘 · 未至之境” |
| Animated desktop | Original upstream `whale-fantasy-loop.mp4`, looping, muted, 1664×856, 25.458333 s |
| Skin background | Enabled; all extra opacity and blur controls set to `0` |
| Startup animation | `dsh-boot-animation@0.4.2` from tagged source `github:NativeDog1/dsh-boot-animation#v0.4.2` |
| Startup selection | `builtin:awakening` (“DeepSeek 数字角色苏醒”), `cover`, random off, play once per app start on |
| Accessory controls | `@local/whale-intro-icons@1.0.0`; film-pin and video-library icons scoped to `whale-fantasy` |

## Procedure

1. Read [installation.md](references/installation.md) and snapshot the existing skin, startup, bundle, and conversation-override state.
2. Install the two exact upstream plugin versions with `plugin_manager`; do not edit the profile package or Cordis patch by hand.
3. Run `scripts/install-skin.sh` with the live `$DSH_HOME`. It downloads the original files from the pinned upstream commit and rejects any checksum mismatch.
4. Apply the exact skin and startup settings through their HTTP APIs, then install `assets/whale-intro-icons` with `plugin_manager`.
5. Read [verification.md](references/verification.md), run `scripts/verify-theme.mjs`, and visually inspect the existing Desktop GUI.
6. Use [rollback.md](references/rollback.md) to restore the snapshot or remove this setup.

## Constraints

- Use the original online skin assets only. Do not generate, redraw, substitute, transcode, or optimize the background artwork or video.
- The matching skin is `whale-fantasy`, not the built-in `blue-fantasy` skin.
- Keep the boot plugin on tagged `v0.4.2`; do not replace it with untagged `main` or silently upgrade it.
- The startup overlay and animated desktop background are separate systems. Do not claim that the startup clip is the source of the desktop animation.
- Preserve existing conversation pins unless the user explicitly requests an exact reset. The verified target has zero per-conversation overrides.
- The icon bundle is additive: it keeps the original buttons, labels, tooltips, disabled state, and click handlers. Never patch installed boot-plugin files directly.
- Treat `plugin_manager` results as authoritative: inspect `application`, `warnings`, and `nextStep`; only supply `approvedBuilds` after explicit user approval for those install scripts.
- Use the existing Harness GUI. Do not start a replacement server to apply or verify this setup.

## Deferred references

- [installation.md](references/installation.md): exact installation order, API payloads, and state snapshot.
- [verification.md](references/verification.md): automated runtime assertions and visual acceptance checks.
- [provenance.md](references/provenance.md): original sources, fixed revision, licenses, media facts, and SHA-256 values.
- [rollback.md](references/rollback.md): non-destructive restoration and bundle removal.
