import { ElectronAPI } from '@electron-toolkit/preload'
import { DecompositionResult } from '../common/types'

declare global {
  interface Window {
    electron: ElectronAPI
    api: {
      // Defining what an API should look like
      decomposeTask: (taskTitle: string, deadline: string, depth: string, selectedModel: string) => Promise<DecompositionResult>
    }
  }
}