# Scribe Release

## Local Build
```bash
cd ~/Documents/code/scribe
npm run tauri build
cp -r src-tauri/target/release/bundle/macos/Scribe.app /Applications/
```

## GitHub Release
```bash
git tag v0.x.x
git push origin v0.x.x
```
GitHub Actions builds and uploads `Scribe-macos.zip` to Releases.

## Output Locations
- **Local .app**: `src-tauri/target/release/bundle/macos/Scribe.app`
- **GitHub**: https://github.com/JabariD/scribe/releases
