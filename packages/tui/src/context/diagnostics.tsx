import { createContext, useContext, type ParentProps } from "solid-js"
import { disabled, type TuiDiagnostics } from "../diagnostics/service"

const context = createContext<TuiDiagnostics>(disabled)

export function DiagnosticsProvider(props: ParentProps<{ value: TuiDiagnostics }>) {
  return <context.Provider value={props.value}>{props.children}</context.Provider>
}

export function useDiagnostics() {
  return useContext(context)
}
