import { createContext, useCallback, useContext, useEffect, useRef, type ReactNode } from 'react'

type BackHandler = () => void

interface DetailBackContextValue {
  setDetailBack: (handler: BackHandler | null) => void
  isDetailOpen: () => boolean
  goBack: () => void
}

const fallback: DetailBackContextValue = {
  setDetailBack: () => undefined,
  isDetailOpen: () => false,
  goBack: () => undefined,
}

const DetailBackContext = createContext<DetailBackContextValue>(fallback)

export function DetailBackProvider({ children }: { children: ReactNode }) {
  const handlerRef = useRef<BackHandler | null>(null)
  const setDetailBack = useCallback((handler: BackHandler | null) => { handlerRef.current = handler }, [])
  const isDetailOpen = useCallback(() => handlerRef.current !== null, [])
  const goBack = useCallback(() => { handlerRef.current?.() }, [])

  return <DetailBackContext.Provider value={{ setDetailBack, isDetailOpen, goBack }}>{children}</DetailBackContext.Provider>
}

export function useDetailBack() {
  return useContext(DetailBackContext)
}

export function useRegisterDetailBack(active: boolean, onBack: BackHandler) {
  const { setDetailBack } = useDetailBack()
  const onBackRef = useRef(onBack)
  onBackRef.current = onBack

  useEffect(() => {
    if (!active) {
      setDetailBack(null)
      return
    }
    setDetailBack(() => onBackRef.current())
    return () => setDetailBack(null)
  }, [active, setDetailBack])
}
