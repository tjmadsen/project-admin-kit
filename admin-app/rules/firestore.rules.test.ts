import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing'
import {
  Timestamp,
  arrayUnion,
  collection,
  deleteDoc,
  doc,
  getDoc,
  runTransaction,
  serverTimestamp,
  setDoc,
  updateDoc,
} from 'firebase/firestore'
import { deleteObject, getMetadata, ref as storageRef, uploadBytes } from 'firebase/storage'

const projectId = 'demo-project-admin'
const adminClaims = { email: 'owner@example.com', email_verified: true }
const creatorClaims = { email: 'collaborator@example.com', email_verified: true }
let testEnv: RulesTestEnvironment

function creatorItem(kind: 'feature' | 'bug', number: number) {
  return {
    kind,
    number,
    title: kind === 'feature' ? 'Creator feature' : 'Creator bug',
    description: 'Submitted from the creator-only console.',
    imageUrls: [],
    priority: 'medium',
    status: kind === 'feature' ? 'backlog' : 'open',
    waitingOn: 'human',
    blockedReason: 'triage',
    assignedTo: 'sol-agent',
    thinkingEffort: 'xhigh',
    targetMachine: 'local-mac',
    deploymentType: 'none',
    deploymentTargets: [],
    messages: [],
    createdByEmail: 'collaborator@example.com',
    createdByRole: 'collaborator',
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  }
}

async function submitAsCreator(kind: 'feature' | 'bug') {
  const db = testEnv.authenticatedContext('logan', creatorClaims).firestore()
  return runTransaction(db, async (transaction) => {
    const counterRef = doc(db, 'system', 'counters')
    const counter = await transaction.get(counterRef)
    const field = kind === 'feature' ? 'nextFeatureNumber' : 'nextBugNumber'
    const number = Number(counter.data()?.[field]) + 1
    const itemRef = doc(collection(db, kind === 'feature' ? 'featureRequests' : 'bugs'))
    transaction.set(counterRef, { [field]: number, updatedAt: serverTimestamp() }, { merge: true })
    transaction.set(itemRef, creatorItem(kind, number))
    return itemRef
  })
}

function pushDeviceToken(uid: string, email: string, deviceId: string, token = 'fcm-token') {
  return {
    uid,
    email,
    deviceId,
    token,
    platform: 'ios_admin',
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  }
}

beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId,
    firestore: {
      rules: readFileSync(resolve(process.cwd(), '../firestore.rules'), 'utf8'),
      host: '127.0.0.1',
      port: 8080,
    },
    storage: {
      rules: readFileSync(resolve(process.cwd(), '../storage.rules'), 'utf8'),
      host: '127.0.0.1',
      port: 9199,
    },
  })
})

beforeEach(async () => {
  await testEnv.clearFirestore()
  await testEnv.clearStorage()
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore()
    await setDoc(doc(db, 'adminUsers', adminClaims.email), { email: adminClaims.email, displayName: 'Owner', role: 'admin', active: true })
    await setDoc(doc(db, 'adminUsers', creatorClaims.email), { email: creatorClaims.email, displayName: 'Collaborator', role: 'collaborator', active: true })
    await setDoc(doc(db, 'system', 'projectConfig'), { defaultWorkOwner: 'sol-agent', defaultMachineId: 'local-mac' })
    await setDoc(doc(db, 'system', 'counters'), { nextFeatureNumber: 10, nextBugNumber: 20 })
    await setDoc(doc(db, 'featureRequests', 'existing-feature'), creatorItem('feature', 10))
    await setDoc(doc(db, 'featureRequests', 'assigned-feature'), {
      ...creatorItem('feature', 11),
      assignedTo: 'sol-agent',
      waitingOn: 'human',
      status: 'blocked',
      blockedReason: 'question',
    })
    await setDoc(doc(db, 'bugs', 'existing-bug'), creatorItem('bug', 20))
    await setDoc(doc(db, 'agentLoopRuns', 'run-1'), { status: 'running' })
    await setDoc(doc(db, 'agentMachines', 'studio-1'), { status: 'online' })
    await setDoc(doc(db, 'system', 'agentLoopConfig'), { deployAgent: 'claude-sonnet' })
    await setDoc(doc(db, 'system', 'agentLoopUsage'), { codex: { usedPercent: 42 } })
  })
})

afterAll(async () => testEnv?.cleanup())

describe('Project collaborator permissions', () => {
  it('lets Collaborator view feature requests and bugs', async () => {
    const db = testEnv.authenticatedContext('logan', creatorClaims).firestore()
    await assertSucceeds(getDoc(doc(db, 'featureRequests', 'existing-feature')))
    await assertSucceeds(getDoc(doc(db, 'bugs', 'existing-bug')))
  })

  it('lets Collaborator submit a constrained feature or bug for Owner review', async () => {
    const featureRef = await assertSucceeds(submitAsCreator('feature'))
    const bugRef = await assertSucceeds(submitAsCreator('bug'))
    expect((await getDoc(featureRef)).data()?.waitingOn).toBe('human')
    expect((await getDoc(bugRef)).data()?.assignedTo).toBe('sol-agent')
    expect((await getDoc(bugRef)).data()?.thinkingEffort).toBe('xhigh')
  })

  it('lets Collaborator set priority while keeping model and thinking effort locked', async () => {
    const db = testEnv.authenticatedContext('logan', creatorClaims).firestore()
    const featureRef = doc(db, 'featureRequests', 'existing-feature')
    await assertSucceeds(updateDoc(featureRef, { priority: 'critical', updatedAt: serverTimestamp() }))
    expect((await getDoc(featureRef)).data()?.priority).toBe('critical')
    await assertFails(updateDoc(featureRef, { assignedTo: 'terra-agent', updatedAt: serverTimestamp() }))
    await assertFails(updateDoc(featureRef, { thinkingEffort: 'low', updatedAt: serverTimestamp() }))
  })

  it('keeps dependency changes exclusive to Owner', async () => {
    const db = testEnv.authenticatedContext('logan', creatorClaims).firestore()
    await assertFails(updateDoc(doc(db, 'featureRequests', 'existing-feature'), {
      dependsOn: ['existing-bug'],
      updatedAt: serverTimestamp(),
    }))
    await assertFails(updateDoc(doc(db, 'bugs', 'existing-bug'), {
      dependsOn: ['existing-feature'],
      updatedAt: serverTimestamp(),
    }))
  })

  it('does not let Collaborator bypass Owner review on a freshly triaged item', async () => {
    const db = testEnv.authenticatedContext('logan', creatorClaims).firestore()
    await assertFails(updateDoc(doc(db, 'featureRequests', 'existing-feature'), {
      messages: arrayUnion({
        author: 'Collaborator User',
        authorEmail: 'collaborator@example.com',
        body: 'Start this immediately.',
        imageUrls: [],
        createdAt: Timestamp.now(),
      }),
      waitingOn: 'agent',
      status: 'in_progress',
      blockedReason: null,
      leaseExpiresAt: null,
      claimedBy: null,
      updatedAt: serverTimestamp(),
    }))
  })

  it('lets Collaborator append an authenticated note without changing workflow state', async () => {
    const db = testEnv.authenticatedContext('logan', creatorClaims).firestore()
    const featureRef = doc(db, 'featureRequests', 'existing-feature')
    await assertSucceeds(updateDoc(featureRef, {
      messages: arrayUnion({
        author: 'Collaborator User',
        authorEmail: 'collaborator@example.com',
        body: 'Here is more context.',
        imageUrls: [],
        createdAt: Timestamp.now(),
      }),
      updatedAt: serverTimestamp(),
    }))
    expect((await getDoc(featureRef)).data()?.messages).toHaveLength(1)
    expect((await getDoc(featureRef)).data()?.waitingOn).toBe('human')
  })

  it('lets Collaborator reply and return a non-deployment question to the assigned AI', async () => {
    const db = testEnv.authenticatedContext('logan', creatorClaims).firestore()
    const featureRef = doc(db, 'featureRequests', 'assigned-feature')
    await assertSucceeds(updateDoc(featureRef, {
      messages: arrayUnion({
        author: 'Collaborator User',
        authorEmail: 'collaborator@example.com',
        body: 'Use the first option.',
        imageUrls: [],
        createdAt: Timestamp.now(),
      }),
      waitingOn: 'agent',
      status: 'in_progress',
      blockedReason: null,
      leaseExpiresAt: null,
      claimedBy: null,
      updatedAt: serverTimestamp(),
    }))
    const result = (await getDoc(featureRef)).data()
    expect(result?.waitingOn).toBe('agent')
    expect(result?.deploymentApprovedBy).toBeUndefined()
  })

  it('rejects management, forged replies, routing-only changes, and deletes from Collaborator', async () => {
    const db = testEnv.authenticatedContext('logan', creatorClaims).firestore()
    const featureRef = doc(db, 'featureRequests', 'existing-feature')
    await assertFails(updateDoc(featureRef, { title: 'Changed' }))
    await assertFails(updateDoc(featureRef, { messages: [{ author: 'Collaborator', body: 'Reply' }] }))
    await assertFails(updateDoc(featureRef, {
      messages: arrayUnion({
        author: 'Owner',
        authorEmail: 'owner@example.com',
        body: 'Forged admin reply',
        imageUrls: [],
        createdAt: Timestamp.now(),
      }),
      updatedAt: serverTimestamp(),
    }))
    await assertFails(updateDoc(featureRef, { waitingOn: 'agent', assignedTo: 'codex-sol-agent' }))
    await assertFails(updateDoc(featureRef, {
      messages: arrayUnion({
        author: 'Collaborator User',
        authorEmail: 'collaborator@example.com',
        body: 'Deploy this now.',
        imageUrls: [],
        createdAt: Timestamp.now(),
      }),
      deploymentApprovedAt: serverTimestamp(),
      deploymentApprovedBy: 'collaborator@example.com',
      waitingOn: 'deployer',
      updatedAt: serverTimestamp(),
    }))
    await assertFails(deleteDoc(featureRef))
  })

  it('prevents Collaborator from returning a deploy approval item to any loop', async () => {
    const adminDb = testEnv.authenticatedContext('tj', adminClaims).firestore()
    await updateDoc(doc(adminDb, 'featureRequests', 'assigned-feature'), {
      status: 'ready_for_deploy',
      waitingOn: 'human',
      blockedReason: 'deploy_approval',
    })
    const db = testEnv.authenticatedContext('logan', creatorClaims).firestore()
    await assertFails(updateDoc(doc(db, 'featureRequests', 'assigned-feature'), {
      messages: arrayUnion({
        author: 'Collaborator User',
        authorEmail: 'collaborator@example.com',
        body: 'Please deploy this.',
        imageUrls: [],
        createdAt: Timestamp.now(),
      }),
      waitingOn: 'agent',
      status: 'in_progress',
      blockedReason: null,
      leaseExpiresAt: null,
      claimedBy: null,
      updatedAt: serverTimestamp(),
    }))
  })

  it('rejects forged routed submissions', async () => {
    const db = testEnv.authenticatedContext('logan', creatorClaims).firestore()
    await assertFails(setDoc(doc(db, 'featureRequests', 'forged'), {
      ...creatorItem('feature', 11),
      waitingOn: 'agent',
      assignedTo: 'codex-sol-agent',
    }))
  })

  it('lets Collaborator read loop telemetry while keeping every operational write blocked', async () => {
    const db = testEnv.authenticatedContext('logan', creatorClaims).firestore()
    await assertSucceeds(getDoc(doc(db, 'agentLoopRuns', 'run-1')))
    await assertSucceeds(getDoc(doc(db, 'agentMachines', 'studio-1')))
    await assertSucceeds(getDoc(doc(db, 'system', 'agentLoopConfig')))
    await assertSucceeds(getDoc(doc(db, 'system', 'agentLoopUsage')))
    await assertFails(setDoc(doc(db, 'agentLoopRuns', 'forged'), { status: 'running' }))
    await assertFails(setDoc(doc(db, 'agentMachines', 'forged'), { status: 'online' }))
    await assertFails(updateDoc(doc(db, 'system', 'agentLoopConfig'), { deployAgent: 'codex-sol' }))
    await assertFails(updateDoc(doc(db, 'system', 'agentLoopUsage'), { codex: { usedPercent: 0 } }))
  })

  it('rejects other accounts entirely', async () => {
    const db = testEnv.authenticatedContext('outsider', { email: 'someone@example.com', email_verified: true }).firestore()
    await assertFails(getDoc(doc(db, 'featureRequests', 'existing-feature')))
  })
})

describe('Project administrator permissions', () => {
  it('keeps unrestricted management access for Owner', async () => {
    const db = testEnv.authenticatedContext('tj', adminClaims).firestore()
    await assertSucceeds(updateDoc(doc(db, 'featureRequests', 'existing-feature'), { waitingOn: 'agent' }))
    await assertSucceeds(updateDoc(doc(db, 'featureRequests', 'existing-feature'), { dependsOn: ['existing-bug'] }))
    await assertSucceeds(updateDoc(doc(db, 'bugs', 'existing-bug'), { dependsOn: ['existing-feature'] }))
    await assertSucceeds(updateDoc(doc(db, 'system', 'agentLoopConfig'), { deployAgent: 'codex-sol' }))
  })

  it('lets an administrator manage access while protecting the current account', async () => {
    const db = testEnv.authenticatedContext('tj', adminClaims).firestore()
    await assertSucceeds(setDoc(doc(db, 'adminUsers', 'new@example.com'), {
      email: 'new@example.com', displayName: 'New person', role: 'collaborator', active: true,
    }))
    await assertSucceeds(updateDoc(doc(db, 'adminUsers', 'new@example.com'), { role: 'admin' }))
    await assertSucceeds(deleteDoc(doc(db, 'adminUsers', 'new@example.com')))
    await assertFails(updateDoc(doc(db, 'adminUsers', adminClaims.email), { active: false }))
    await assertFails(deleteDoc(doc(db, 'adminUsers', adminClaims.email)))
  })

  it('lets users read only their own access record', async () => {
    const collaboratorDb = testEnv.authenticatedContext('logan', creatorClaims).firestore()
    await assertSucceeds(getDoc(doc(collaboratorDb, 'adminUsers', creatorClaims.email)))
    await assertFails(getDoc(doc(collaboratorDb, 'adminUsers', adminClaims.email)))
    await assertFails(updateDoc(doc(collaboratorDb, 'adminUsers', creatorClaims.email), { role: 'admin' }))
  })
})

describe('Project Admin push token permissions', () => {
  it('lets Owner and Collaborator create, refresh, read, and remove only their own registrations', async () => {
    const adminDb = testEnv.authenticatedContext('tj', adminClaims).firestore()
    const creatorDb = testEnv.authenticatedContext('logan', creatorClaims).firestore()
    const tjToken = doc(adminDb, 'pushDeviceTokens', 'tj_phone-one')
    const loganToken = doc(creatorDb, 'pushDeviceTokens', 'logan_phone-two')

    await assertSucceeds(setDoc(tjToken, pushDeviceToken('tj', adminClaims.email, 'phone-one')))
    await assertSucceeds(setDoc(loganToken, pushDeviceToken('logan', creatorClaims.email, 'phone-two')))
    await assertSucceeds(getDoc(tjToken))
    await assertSucceeds(getDoc(loganToken))
    await assertSucceeds(updateDoc(tjToken, {
      token: 'rotated-fcm-token',
      updatedAt: serverTimestamp(),
    }))
    await assertSucceeds(deleteDoc(tjToken))
    await assertSucceeds(deleteDoc(loganToken))
  })

  it('rejects forged identities, mismatched document IDs, and cross-user reads', async () => {
    const adminDb = testEnv.authenticatedContext('tj', adminClaims).firestore()
    const creatorDb = testEnv.authenticatedContext('logan', creatorClaims).firestore()
    const adminToken = doc(adminDb, 'pushDeviceTokens', 'tj_phone-one')
    const creatorToken = doc(creatorDb, 'pushDeviceTokens', 'logan_phone-two')
    await assertSucceeds(setDoc(
      adminToken,
      pushDeviceToken('tj', adminClaims.email, 'phone-one'),
    ))
    await assertSucceeds(setDoc(
      creatorToken,
      pushDeviceToken('logan', creatorClaims.email, 'phone-two'),
    ))

    await assertFails(setDoc(
      doc(creatorDb, 'pushDeviceTokens', 'tj_forged'),
      pushDeviceToken('tj', adminClaims.email, 'forged'),
    ))
    await assertFails(setDoc(
      doc(creatorDb, 'pushDeviceTokens', 'logan_wrong-id'),
      pushDeviceToken('logan', creatorClaims.email, 'different-id'),
    ))
    await assertFails(getDoc(doc(creatorDb, 'pushDeviceTokens', 'tj_phone-one')))
    await assertFails(updateDoc(doc(creatorDb, 'pushDeviceTokens', 'tj_phone-one'), {
      token: 'stolen-token',
      updatedAt: serverTimestamp(),
    }))
    await assertFails(getDoc(doc(adminDb, 'pushDeviceTokens', 'logan_phone-two')))
    await assertFails(updateDoc(doc(adminDb, 'pushDeviceTokens', 'logan_phone-two'), {
      token: 'admin-overwrite',
      updatedAt: serverTimestamp(),
    }))
    await assertFails(deleteDoc(doc(adminDb, 'pushDeviceTokens', 'logan_phone-two')))
  })

  it('rejects unverified collaborators, outsiders, and unsupported token shapes', async () => {
    const unverifiedDb = testEnv.authenticatedContext('unverified', {
      email: adminClaims.email,
      email_verified: false,
    }).firestore()
    const outsiderDb = testEnv.authenticatedContext('outsider', {
      email: 'someone@example.com',
      email_verified: true,
    }).firestore()
    const creatorDb = testEnv.authenticatedContext('logan', creatorClaims).firestore()

    await assertFails(setDoc(
      doc(unverifiedDb, 'pushDeviceTokens', 'unverified_phone'),
      pushDeviceToken('unverified', adminClaims.email, 'phone'),
    ))
    await assertFails(setDoc(
      doc(outsiderDb, 'pushDeviceTokens', 'outsider_phone'),
      pushDeviceToken('outsider', 'someone@example.com', 'phone'),
    ))
    await assertFails(setDoc(doc(creatorDb, 'pushDeviceTokens', 'logan_phone'), {
      ...pushDeviceToken('logan', creatorClaims.email, 'phone'),
      platform: 'unknown_client',
    }))
  })
})

describe('Project Admin work-item attachment permissions', () => {
  const metadata = (email: string, contentType = 'image/png') => ({
    contentType,
    customMetadata: { uploaderEmail: email, kind: 'feature', itemId: 'feature-11' },
  })

  it('lets Collaborator upload and view an image in his own attachment path', async () => {
    const storage = testEnv.authenticatedContext('logan', creatorClaims).storage()
    const image = storageRef(storage, 'work-item-attachments/logan/feature/feature-11/shot.png')
    await assertSucceeds(uploadBytes(image, new Uint8Array([137, 80, 78, 71]), metadata('collaborator@example.com')))
    await assertSucceeds(getMetadata(image))
    await assertSucceeds(deleteObject(image))
  })

  it('lets Collaborator upload PDF, CSV, and TXT attachments', async () => {
    const storage = testEnv.authenticatedContext('logan', creatorClaims).storage()
    const documents = [
      ['report.pdf', 'application/pdf'],
      ['players.csv', 'text/csv'],
      ['notes.txt', 'text/plain'],
    ] as const
    for (const [name, contentType] of documents) {
      const document = storageRef(storage, `work-item-attachments/logan/feature/feature-11/${name}`)
      await assertSucceeds(uploadBytes(document, new Uint8Array([1]), metadata('collaborator@example.com', contentType)))
      await assertSucceeds(getMetadata(document))
    }
  })

  it('rejects uploads outside the caller path or with an unsupported type', async () => {
    const storage = testEnv.authenticatedContext('logan', creatorClaims).storage()
    await assertFails(uploadBytes(storageRef(storage, 'work-item-attachments/tj/feature/feature-11/shot.png'), new Uint8Array([1]), metadata('collaborator@example.com')))
    await assertFails(uploadBytes(storageRef(storage, 'work-item-attachments/logan/feature/feature-11/notes.docx'), new Uint8Array([1]), metadata('collaborator@example.com', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')))
    await assertFails(uploadBytes(storageRef(storage, 'work-item-attachments/logan/feature/feature-11/disguised.exe'), new Uint8Array([1]), metadata('collaborator@example.com', 'text/plain')))
  })

  it('keeps attachments private from other accounts', async () => {
    const loganStorage = testEnv.authenticatedContext('logan', creatorClaims).storage()
    const image = storageRef(loganStorage, 'work-item-attachments/logan/feature/feature-11/private.png')
    await assertSucceeds(uploadBytes(image, new Uint8Array([1]), metadata('collaborator@example.com')))
    const outsiderStorage = testEnv.authenticatedContext('outsider', { email: 'someone@example.com', email_verified: true }).storage()
    await assertFails(getMetadata(storageRef(outsiderStorage, 'work-item-attachments/logan/feature/feature-11/private.png')))
  })

  it('lets Collaborator attach screenshots to replies after an item exists', async () => {
    const storage = testEnv.authenticatedContext('logan', creatorClaims).storage()
    const image = storageRef(storage, 'work-item-attachments/logan/feature/existing-feature/late.png')
    await assertSucceeds(uploadBytes(image, new Uint8Array([1]), metadata('collaborator@example.com')))
    await assertSucceeds(deleteObject(image))
  })

  it('lets Owner remove a creator attachment', async () => {
    const loganStorage = testEnv.authenticatedContext('logan', creatorClaims).storage()
    const path = 'work-item-attachments/logan/feature/feature-11/admin-removable.png'
    await assertSucceeds(uploadBytes(storageRef(loganStorage, path), new Uint8Array([1]), metadata('collaborator@example.com')))
    const adminStorage = testEnv.authenticatedContext('tj', adminClaims).storage()
    await assertSucceeds(deleteObject(storageRef(adminStorage, path)))
  })
})
