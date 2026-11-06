# Installation

## Preconditions

- This recipe was verified on DSH `0.2.2-rc.1`, macOS Desktop, and profile `desktop`.
- Use the `$DSH_HOME` and `$DSH_PROFILE_DIR` exposed by the current Harness runtime. Do not embed a development build path in scripts or profile state.
- Obtain the current Web GUI URL from runtime context. The examples call it `$DSH_WEB_URL`.
- Load `cordis-plugin-development`, then inspect the current Host and Client providers before plugin work. Inspect methods are read-only discovery and are not business services for plugin code.

## 1. Snapshot before changing anything

Record all of the following so rollback can restore the actual prior state:

1. `plugin_manager` results for bundle names `@linxin666/dsh-client-ui-skin-center`, `dsh-boot-animation`, and `@local/whale-intro-icons`.
2. `GET $DSH_WEB_URL/api/skin-center/v2/active` when the route exists.
3. `GET $DSH_WEB_URL/dsh-boot-animation/status.json` and `GET $DSH_WEB_URL/dsh-boot-animation/videos.json` when the routes exist.
4. Whether `$DSH_HOME/skins/whale-fantasy` already exists. `scripts/install-skin.sh` archives an existing directory before replacement; retain the printed backup path.
5. The boot status field `conversationOverrideCount`. Do not clear nonzero overrides without explicit user approval.

Absence of a route before its plugin is installed is expected. Other failures need investigation.

## 2. Install exact plugin versions

Use `plugin_manager` with `action: install_bundle` in this order:

| Target | Expected installed result |
| --- | --- |
| `@linxin666/dsh-client-ui-skin-center@0.4.15` | Bundle `@linxin666/dsh-client-ui-skin-center`, version `0.4.15`, row `ui-skin-center` active |
| `github:NativeDog1/dsh-boot-animation#v0.4.2` | Bundle `dsh-boot-animation`, version `0.4.2`, row `dsh-boot-animation` active |

List first and skip an exact active match. Do not use a floating Git branch for the boot plugin. If an install result says it is not applied, follow its `nextStep` before continuing. A peer-warning line in raw package-manager output is not by itself a failure; `application` and `warnings` are the decision fields.

## 3. Install original skin assets

From the directory containing this Skill:

```sh
DSH_HOME="${DSH_HOME:?}" bash scripts/install-skin.sh
```

The script downloads from the fixed upstream commit, verifies every file, archives any existing `whale-fantasy` directory beside it, and moves the verified staging directory into `$DSH_HOME/skins/whale-fantasy`. Failed downloads are cleaned up, and a replacement failure restores the archived skin. It never downloads replacement artwork from another source.

To audit an installed copy without changing it:

```sh
DSH_HOME="${DSH_HOME:?}" bash scripts/install-skin.sh --check
```

## 4. Apply the exact skin state

Use the existing GUI origin and post the complete state document:

```sh
curl -fsS -X POST "$DSH_WEB_URL/api/skin-center/v2/active" \
  -H 'content-type: application/json' \
  --data-binary '{
    "active":"whale-fantasy",
    "background":{
      "enabled":true,
      "backgroundOpacity":0,
      "backgroundBlurEmpty":0,
      "backgroundBlurContent":0,
      "inputCardBlur":0,
      "bubbleOpacity":0,
      "bubbleBlur":0
    }
  }'
```

Read the endpoint back. It must report `active: "whale-fantasy"` and the same background values. In the page, `html[data-dsh-skin="whale-fantasy"]` must appear after activation.

## 5. Apply the startup animation state

Configure the plugin through its supported selection route:

```sh
curl -fsS -X POST "$DSH_WEB_URL/dsh-boot-animation/select" \
  -H 'content-type: application/json' \
  --data-binary '{
    "scope":"global",
    "selectedClipId":"builtin:awakening",
    "randomPlayback":false,
    "fitMode":"cover",
    "playOnAppStart":true
  }'
```

Expected values are:

- selected clip: `builtin:awakening`, displayed as “DeepSeek 数字角色苏醒”;
- random playback: off;
- fit: `cover`, so the video fills the window and may crop at the edges;
- app-start playback: on, once per Desktop launch;
- conversation overrides: unchanged. The verified baseline has none.

The lower-left pin remains independent: a pinned conversation replays on every entry. The adjacent library button opens the clip picker.

## 6. Install the accessory icon bundle

Resolve `assets/whale-intro-icons` relative to this Skill, then pass its absolute path to `plugin_manager` with `action: install_bundle`. The expected package is `@local/whale-intro-icons@1.0.0`, row id `whale-intro-icons`, with `application: "applied"` and no warnings.

The client patch is scoped to:

```css
html[data-dsh-skin="whale-fantasy"] .dba-pin-wrap > button.dba-pin
```

It therefore disappears when another skin is active and does not alter the boot plugin's DOM or event handlers.

## 7. Refresh only when required

Use the live application result first. If the plugin manager returns a restart instruction, fully quit and reopen Desktop. If an old immutable client bundle remains cached, hard-refresh the existing window. Do not start a second Web server; it does not update the active Desktop GUI.
