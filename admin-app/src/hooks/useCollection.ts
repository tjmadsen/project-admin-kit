import { useEffect, useState } from 'react'
import { collection, limit, onSnapshot, orderBy, query } from 'firebase/firestore'
import { db } from '../lib/firebase'

export function useCollection<T extends { id: string }>(path: string, max = 250) {
  const [data, setData] = useState<T[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    const q = query(collection(db, path), orderBy('updatedAt', 'desc'), limit(max))
    return onSnapshot(q, (snapshot) => {
      setData(snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }) as T))
      setLoading(false)
      setError('')
    }, (err) => {
      setError(err.message)
      setLoading(false)
    })
  }, [path, max])

  return { data, loading, error }
}
