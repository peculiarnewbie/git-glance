import type { RPCSchema } from "electrobun/view"

export type DesktopRPC = {
  bun: RPCSchema<{
    requests: {
      selectDirectory: { params: {}; response: string | null }
    }
    messages: {}
  }>
  webview: RPCSchema<{
    requests: {}
    messages: {}
  }>
}
