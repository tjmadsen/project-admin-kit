'use strict';

const { Firestore } = require('@google-cloud/firestore');
const { loadProjectConfig } = require('./project-config');

const projectId = process.env.PROJECT_ADMIN_FIREBASE_PROJECT || loadProjectConfig().project.firebaseProjectId;
module.exports = new Firestore({ projectId });
