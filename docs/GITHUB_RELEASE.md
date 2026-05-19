# GitHub Release Checklist

Use this checklist when publishing a new Website Viewer release.

1. Update `package.json` version if this is not `v1.0.0`.
2. Update `RELEASE_NOTES.md`.
3. Run:

```bash
npm install
npm run release
```

4. Smoke-test the generated folder:

```bash
cd dist/Website-Viewer-release
npm run launch
```

5. Confirm the app opens, a small public URL list loads, and screenshots populate.
6. Create a GitHub release tag such as `v1.0.0`.
7. Upload `dist/Website-Viewer-v1.0.0.zip` as the release asset.
8. Paste the relevant section of `RELEASE_NOTES.md` into the release description.

Before uploading, make sure the archive does not contain `node_modules`, `.env` files, keys, certificates, old zips, logs, or runtime cache folders. The release script excludes these automatically, but it is worth checking before a public upload.
