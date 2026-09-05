import rawConfig from '../../../project-admin.config.json'

export interface ProjectAdminConfig {
  schemaVersion: 1
  project: {
    name: string
    shortName: string
    slug: string
    description: string
    productionUrl: string
    vercelProductionUrl?: string
    adminPath: string
    firebaseProjectId: string
    firestoreLocation: string
  }
  firebase: {
    apiKey: string
    authDomain: string
    storageBucket: string
    messagingSenderId: string
    appId: string
    measurementId?: string
  }
  repository: { slug: string; defaultBranch: string }
  admin: { ownerName: string; ownerEmail: string; defaultCollaboratorName: string }
  automation: {
    defaultMachineId: string
    defaultMachineLabel: string
    defaultWorkAgent: string
    defaultDeployAgent: string
    stateDirectory: string
    logDirectoryName: string
  }
  deployments: Record<string, boolean>
}

export const projectConfig = rawConfig as ProjectAdminConfig
export const adminBaseUrl = `${projectConfig.project.productionUrl.replace(/\/$/, '')}${projectConfig.project.adminPath}`
export const preferencePrefix = `project-admin:${projectConfig.project.slug}`
