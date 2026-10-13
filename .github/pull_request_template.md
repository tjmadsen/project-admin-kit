## What and why

<!-- One concern per PR. Link the issue it closes, if any. -->

## How it was tested

<!-- Tick what you ran; CONTRIBUTING.md has the matrix. -->

- [ ] `npm --prefix admin-app test`
- [ ] `npm --prefix scripts test`
- [ ] `npm run build`
- [ ] `npm run test:rules` (rules or work-kind changes)
- [ ] `npm run test:extras` (changes under `extras/`)
- [ ] `node scripts/lib/work-kinds.js check` and `node scripts/lib/deploy-targets.js check`
- [ ] Before/after screenshots attached (visible console changes)

## Checklist

- [ ] Docs and `CHANGELOG.md` updated for user-visible or breaking changes
- [ ] No rebuilt `public/admin/` bundle, credentials, real project ids, email addresses, or local paths
- [ ] Changes to human gates, deploy scope, or agent permissions are called out above
