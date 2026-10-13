#!/usr/bin/env node
'use strict';
// Shim kept for runbooks and prompts: work-agent.js scoped to bugs.
process.env.PROJECT_ADMIN_WORK_KIND = 'bug';
require('./lib/backlog-agent').runCli();
