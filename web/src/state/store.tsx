// 零依赖状态容器：useReducer + 两个 context（状态、派发）。getState 给探针与网络回调用，永不过期。

import { createContext, useContext, useMemo, useReducer, useRef, type ReactNode } from 'react'
import { initialState, reducer } from './reducer.js'
import type { Action, AppState, ResultsTab, View } from './types.js'

export type Dispatch = (a: Action) => void
export interface StoreApi { dispatch: Dispatch; getState: () => AppState }

const StateContext = createContext<AppState | null>(null)
const ApiContext = createContext<StoreApi | null>(null)

export function StoreProvider({ devMode, diagramText, route, children }: { devMode: boolean; diagramText: string; route?: { view: View; resultsTab: ResultsTab }; children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, undefined, () => initialState(devMode, window.innerWidth, diagramText, route))
  const ref = useRef(state)
  ref.current = state
  const api = useMemo<StoreApi>(() => ({ dispatch, getState: () => ref.current }), [dispatch])
  return (
    <ApiContext.Provider value={api}>
      <StateContext.Provider value={state}>{children}</StateContext.Provider>
    </ApiContext.Provider>
  )
}

export function useAppState(): AppState {
  const s = useContext(StateContext)
  if (!s) throw new Error('useAppState 必须在 StoreProvider 内')
  return s
}

export function useStore(): StoreApi {
  const a = useContext(ApiContext)
  if (!a) throw new Error('useStore 必须在 StoreProvider 内')
  return a
}

export function useDispatch(): Dispatch { return useStore().dispatch }
