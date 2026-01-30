# Scribe Release

Release workflow for Scribe. No GitHub Actions - agent runs tests, builds, and uploads directly.

## Quick Release

```bash
cd ~/Documents/code/scribe

# 1. Bump version in all three files
#    - package.json
#    - src-tauri/Cargo.toml  
#    - src-tauri/tauri.conf.json

# 2. Run tests
cd src-tauri && cargo test && cd ..

# 3. Build
npm run tauri build

# 4. Create release artifacts
cd src-tauri/target/release/bundle/macos
zip -r Scribe_X.X.X_aarch64.zip Scribe.app
cd -

# 5. Commit, tag, push
git add -A
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

All three must match:
- `package.json` → `"version": "X.X.X"`
- `src-tauri/Cargo.toml` → `version = "X.X.X"`
- `src-tauri/tauri.conf.json` → `"version": "X.X.X"`

## Build Outputs

| File | Location |
|------|----------|
| macOS .app | `src-tauri/target/release/bundle/macos/Scribe.app` |
| DMG installer | `src-tauri/target/release/bundle/dmg/Scribe_X.X.X_aarch64.dmg` |
| Zip bundle | Create manually from .app |

## Local Install

```bash
cp -r src-tauri/target/release/bundle/macos/Scribe.app /Applications/
```

## GitHub Releases

https://github.com/JabariD/scribe/releases
