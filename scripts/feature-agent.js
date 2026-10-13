#!/usr/bin/env node
'use strict';
// Shim kept for runbooks and prompts: work-agent.js scoped to feature requests.
process.env.PROJECT_ADMIN_WORK_KIND = 'feature';
require('./lib/backlog-agent').runCli();
