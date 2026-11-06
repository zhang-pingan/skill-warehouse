# Verification

Verification is complete only when package state, persistent settings, DOM state, media playback, and the visible GUI agree.

## Automated runtime check

With the Desktop CDP endpoint available, run from this Skill directory:

```sh
node scripts/verify-theme.mjs --cdp-url http://127.0.0.1:9222
```

The script locates the existing `dsh-app://app/` page. A backgrounded Desktop window may throttle its muted video, so the check resumes that expected video before sampling its timeline. It then asserts:

- active skin and root attribute are `whale-fantasy`;
- all background opacity/blur settings match the verified zero-blur state;
- the original `whale-fantasy-loop.mp4` is mounted, ready, muted, looping, and its timeline advances;
- boot selection is `builtin:awakening`, random off, `cover`, app-start on, and no conversation override;
- the accessory stylesheet is present and both original lower-left controls have mask icons at 18 px.

Any failed assertion exits nonzero and prints the complete observed state. Investigate the failed layer instead of weakening the check.

## Package check

Use `plugin_manager` to confirm these exact active rows:

| Row | Package version/source |
| --- | --- |
| `ui-skin-center` | `@linxin666/dsh-client-ui-skin-center@0.4.15` |
| `dsh-boot-animation` | `dsh-boot-animation@0.4.2`, source tag `v0.4.2` |
| `whale-intro-icons` | `@local/whale-intro-icons@1.0.0` from this Skill asset directory |

Also run `bash scripts/install-skin.sh --check` with the current `$DSH_HOME` to verify all original skin bytes.

## Visual acceptance

Inspect the existing Desktop window, not a mock or replacement server:

1. The full GUI uses the cold black-blue holographic shell and the animated blue-haired character/data-rain video. No black strip appears at the top.
2. The video remains sharp and visibly moves; it is not a static preview, blurred wallpaper, or `blue-fantasy` fallback.
3. Panels remain translucent enough to reveal motion while text and controls stay readable.
4. At lower left, the first control is a film frame with a pin and the second is a stacked video-library mark. Resting color is cold blue; hover, focus, and pinned state are cyan `#39ffd1`.
5. Hover tooltips still describe pin-current-conversation and open-clip-library actions. Open and close the library once; do not change the selected clip during this check.
6. Use the library's preview action to verify “DeepSeek 数字角色苏醒” without restarting. The overlay fills the window and can be skipped.

Do not click the pin button solely for testing; that mutates conversation state. If pinned styling must be checked, temporarily add the CSS class in DevTools and restore the original class immediately.

The verified control appearance is captured in [applied-icons.png](../assets/whale-intro-icons/applied-icons.png).

## Known interpretation

The animated desktop video belongs to `whale-fantasy`. The startup overlay belongs to `dsh-boot-animation`. Their visual coordination is this recipe's configuration, not evidence that both media assets came from the same source.
