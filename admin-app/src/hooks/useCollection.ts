import { useEffect, useState } from 'react'
import { subscribeQuery } from '../data'

export function useCollection<T extends { id: string }>(path: string, max = 250) {
  const [data, setData] = useState<T[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => subscribeQuery({ collection: path, orderBy: 'updatedAt', direction: 'desc', limit: max }, (rows) => {
    setData(rows as unknown as T[])
    setLoading(false)
    setError('')
  }, (err) => {
    setError(err.message)
    setLoading(false)
  }), [path, max])

  return { data, loading, error }
}
