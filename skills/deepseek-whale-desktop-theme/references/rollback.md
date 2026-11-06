# Rollback

Rollback should restore the snapshot taken before installation. Do not assume the official default was the user's prior state.

## Restore visual state

To disable the catalog skin while retaining installed assets:

```sh
curl -fsS -X POST "$DSH_WEB_URL/api/skin-center/v2/active" \
  -H 'content-type: application/json' \
  --data-binary '{"active":null}'
```

If the snapshot named another skin and background settings, post that complete prior document instead. Read it back and verify the page attribute.

`scripts/install-skin.sh` prints a backup path when it replaces an existing `whale-fantasy` directory. To restore that directory, first confirm the absolute current target is exactly `$DSH_HOME/skins/whale-fantasy`, archive the current target under a new name, then move the recorded backup into place. Never delete an unverified computed path.

## Restore startup choices

Post the snapshot values to `/dsh-boot-animation/select`. The route accepts `selectedClipId`, `randomPlayback`, `fitMode`, and `playOnAppStart` in one global request.

Conversation overrides are separate. Restore or remove each known override with:

```json
{
  "scope": "conversation",
  "sessionId": "<session-id>",
  "id": "<clip-id-or-null>"
}
```

Do not clear unknown user pins just to match the zero-override verification baseline.

## Remove installed bundles

Only remove a bundle if the snapshot shows it was introduced by this setup. Use `plugin_manager` with `action: remove_bundle`, in this order:

1. `@local/whale-intro-icons`
2. `dsh-boot-animation`
3. `@linxin666/dsh-client-ui-skin-center`

Read `application`, `warnings`, and `nextStep` after every action. Removing Skin Center is unnecessary if other installed skins use it.

The skin directory is user data, not an npm bundle. Leaving it inactive is the safest rollback. Archive it only when the user explicitly asks to remove local assets.

## Confirm rollback

- The active endpoint matches the pre-change snapshot or is `null`.
- Removed rows no longer appear active in `plugin_manager`.
- The boot endpoint is absent only if the boot bundle was removed; otherwise it matches the restored selection.
- No `#whale-intro-icons-style` remains after the accessory bundle is removed.
- Refresh or restart only when a plugin-manager `nextStep` requires it.
