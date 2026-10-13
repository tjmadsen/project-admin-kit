#!/usr/bin/env node
'use strict';
// Backlog CLI for every configured work kind:
//   node scripts/work-agent.js --kind <kind> <command> [id] --as <agent> ...
// PROJECT_ADMIN_WORK_KIND may stand in for --kind. Item-scoped commands
// (show, reply, pr, deploy-check, ...) and deploy-next work without a kind.
require('./lib/backlog-agent').runCli();
