# Scribe Release

Release workflow for Scribe. No GitHub Actions - agent runs tests, builds, and uploads directly.

## Quick Release

```bash
cd ~/Documents/Code/scribe

# 1. Bump version in all five release metadata files
#    - package.json and package-lock.json
#    - src-tauri/Cargo.toml and src-tauri/Cargo.lock
#    - src-tauri/tauri.conf.json

# 2. Run tests
npm run build
cd src-tauri && cargo fmt --check && cargo test && cargo clippy --all-targets --all-features -- -D warnings && cd ..

# 3. Build
npm run tauri build

# 4. Create release artifacts
cd src-tauri/target/release/bundle/macos
ditto -c -k --sequesterRsrc --keepParent Scribe.app Scribe_X.X.X_aarch64.zip
cd -

# 5. Commit, tag, push
# Review the worktree and stage only the intended release files. Include both
# updated lockfiles: package-lock.json and src-tauri/Cargo.lock.
git status --short
git add <intended-files>
git commit -m "chore: bump version to X.X.X"
git push origin main

# 6. Create GitHub release with artifacts
gh release create vX.X.X \
  --title "vX.X.X - Title" \
  --notes "Release notes here" \
  src-tauri/target/release/bundle/dmg/Scribe_X.X.X_aarch64.dmg \
  src-tauri/target/release/bundle/macos/Scribe_X.X.X_aarch64.zip
```

## Version Files

These release metadata files must match:
- `package.json` and `package-lock.json` → `"version": "X.X.X"`
- `src-tauri/Cargo.toml` and `src-tauri/Cargo.lock` → `version = "X.X.X"`
- `src-tauri/tauri.conf.json` → `"version": "X.X.X"`

## Build Outputs

| File | Location |
|------|----------|
| macOS .app | `src-tauri/target/release/bundle/macos/Scribe.app` |
| DMG installer | `src-tauri/target/release/bundle/dmg/Scribe_X.X.X_aarch64.dmg` |
| Zip bundle | Create manually from .app |

### DMG fallback when Finder automation is unavailable

If Tauri finishes the `.app` but its DMG step fails with Apple Events error `-1743`, create a standard drag-to-Applications image without Finder window decoration:

```bash
scribe_dmg_stage=$(mktemp -d /tmp/scribe-dmg.XXXXXX)
ditto src-tauri/target/release/bundle/macos/Scribe.app "$scribe_dmg_stage/Scribe.app"
ln -s /Applications "$scribe_dmg_stage/Applications"
hdiutil create -volname Scribe -srcfolder "$scribe_dmg_stage" -ov -format UDZO \
  src-tauri/target/release/bundle/dmg/Scribe_X.X.X_aarch64.dmg
rm -rf "$scribe_dmg_stage"
```

## Local Install

```bash
pkill -x Scribe 2>/dev/null || true
rm -rf /Applications/Scribe.app
cp -R src-tauri/target/release/bundle/macos/Scribe.app /Applications/Scribe.app
```

## GitHub Releases

https://github.com/JabariD/scribe/releases
