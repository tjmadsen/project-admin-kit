// Stand-in for src/lib/firebase.ts inside the screenshot harness. A demo project
// keeps doc()/collection() references valid without ever touching production.
import { initializeApp } from 'firebase/app'
import { getAuth } from 'firebase/auth'
import { getFirestore } from 'firebase/firestore'
import { getStorage } from 'firebase/storage'

const app = initializeApp({
  apiKey: 'demo-screenshots',
  authDomain: 'demo-project-admin-screenshots.firebaseapp.com',
  projectId: 'demo-project-admin-screenshots',
  storageBucket: 'demo-project-admin-screenshots.appspot.com',
  appId: '1:0:web:screenshots',
})

export const auth = getAuth(app)
export const db = getFirestore(app)
export const storage = getStorage(app)

export async function signInWithGoogle() {
  /* The harness never signs in. */
}
