import React, { useState, useEffect } from 'react'
import { ChatMessage, ProjectTask, cleanTaskTitle } from 'src/common/types'
import { DEFAULT_CHAT_MODEL } from 'src/common/models'
import { localDateKey } from 'src/common/schedule'
import { TaskDetail } from './TaskDetails'
import { ModelSelect } from './ModelSelect'
import { ChatThread } from './ChatThread'
import { ContextLedgerPanel } from './ContextLedgerPanel'
import { SavedTaskList } from './SavedTaskList'

interface WorkspaceProps {
  projectId: string
  initialTaskId?: string
  onBack: () => void
  onStartFocus: (taskId: string) => void
}

export function ProjectWorkspace({
  projectId,
  initialTaskId,
  onBack,
  onStartFocus
}: WorkspaceProps): React.JSX.Element {
  // --- SCHEDULING CONTROLS (explicit, not conversational) ---
  // Model comes from persisted settings; changing it here updates the default.
  const [selectedModel, setSelectedModel] = useState(DEFAULT_CHAT_MODEL)
  const [deadline, setDeadline] = useState(localDateKey(new Date()))
  const [depth, setDepth] = useState('Brief')

  // --- CONVERSATION STATE ---
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [inputText, setInputText] = useState('')
  const [loading, setLoading] = useState(false)
  const [streamingText, setStreamingText] = useState('')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  // --- ATTACHMENT STATE ---
  // Extracted text is persisted straight into context.md by the main
  // process - the renderer only tracks the filename for the chip.
  const [attachedFileName, setAttachedFileName] = useState<string | null>(null)
  const [attaching, setAttaching] = useState(false)

  // --- COMPLETION STATE ---
  const [phase, setPhase] = useState<'chat' | 'complete'>('chat')
  const [finalTask, setFinalTask] = useState<ProjectTask | null>(null)

  // --- HISTORY STATE ---
  const [projectHistory, setProjectHistory] = useState<ProjectTask[]>([])
  const [viewingTask, setViewingTask] = useState<ProjectTask | null>(null)

  // --- CONTEXT LEDGER VIEWER ---
  const [showContext, setShowContext] = useState(false)

  // --- LOAD HISTORY ON MOUNT ---
  useEffect(() => {
    const loadData = async () => {
      try {
        const data = await window.api.loadProjectData(projectId)
        if (data && data.tasks) {
          setProjectHistory(data.tasks)
          if (initialTaskId) {
            const target = data.tasks.find((t: ProjectTask) => t.id === initialTaskId)
            if (target) setViewingTask(target)
          }
        }
      } catch (e) {
        console.error('Failed to load history', e)
      }
    }
    loadData()
  }, [projectId, initialTaskId])

  useEffect(() => {
    window.api.getSettings().then((settings) => setSelectedModel(settings.chatModel))
  }, [])

  const handleModelChange = (model: string): void => {
    setSelectedModel(model)
    window.api.saveSettings({ chatModel: model })
  }

  // Live tokens for the clarifying question being generated.
  useEffect(() => window.api.onChatStream((text) => setStreamingText((prev) => prev + text)), [])

  // --- HANDLERS ---

  const firstUserMessage = messages.find((m) => m.role === 'user')?.content ?? ''

  const handleSend = async (): Promise<void> => {
    if (!inputText.trim() || loading) return

    const nextMessages: ChatMessage[] = [...messages, { role: 'user', content: inputText }]
    setMessages(nextMessages)
    setInputText('')
    setLoading(true)
    setStreamingText('')
    setErrorMessage(null)

    try {
      const response = await window.api.sendChatMessage({
        projectId,
        messages: nextMessages,
        deadline,
        depth,
        model: selectedModel
      })

      // Engine-level problem (e.g. missing API key). Surface the message as a
      // banner and drop the optimistic user bubble so they can retry.
      if (response.status === 'error') {
        setMessages(messages)
        setErrorMessage(response.message)
        return
      }

      if (response.status === 'clarifying') {
        setMessages([...nextMessages, { role: 'assistant', content: response.message }])
        return
      }

      // status === 'complete'
      setMessages([...nextMessages, { role: 'assistant', content: response.message }])

      const newTask: ProjectTask = {
        id: Date.now().toString(),
        title:
          cleanTaskTitle(firstUserMessage) ||
          cleanTaskTitle(response.data?.originalTask ?? '') ||
          'Untitled task',
        createdAt: new Date().toISOString(),
        deadline,
        subtasks: (response.data?.subtasks ?? []).map((s) => ({ ...s, isCompleted: false })),
        prerequisites: (response.data?.prerequisites ?? []).map((p) => ({ ...p, isCompleted: false })),
        status: 'in-progress',
        depth,
        model: selectedModel,
        conversation: [...nextMessages, { role: 'assistant', content: response.message }]
      }

      const currentFile = (await window.api.loadProjectData(projectId)) || { tasks: [] }
      if (!currentFile.tasks) currentFile.tasks = []
      currentFile.tasks.push(newTask)
      await window.api.saveProjectData(projectId, currentFile)

      setProjectHistory((prev) => [...prev, newTask])
      setFinalTask(newTask)
      setPhase('complete')
    } catch (error) {
      console.error(error)
      setErrorMessage('System Error. Please try again.')
    } finally {
      setLoading(false)
      setStreamingText('')
    }
  }

  const handleAttach = async (): Promise<void> => {
    setAttaching(true)
    setErrorMessage(null)
    try {
      const result = await window.api.selectAndExtractDocument(projectId, firstUserMessage || 'task context')
      if (result?.error) {
        setErrorMessage(result.error)
      } else if (result) {
        setAttachedFileName(result.fileName)
      }
    } catch (error) {
      console.error(error)
      setErrorMessage("Couldn't read that document.")
    } finally {
      setAttaching(false)
    }
  }

  const handleNewTask = (): void => {
    setMessages([])
    setInputText('')
    setAttachedFileName(null)
    setFinalTask(null)
    setPhase('chat')
    setErrorMessage(null)
  }

  const handleViewTask = (task: ProjectTask) => setViewingTask(task)

  const handleDeleteTask = async (e: React.MouseEvent, task: ProjectTask): Promise<void> => {
    e.stopPropagation()
    if (!window.confirm(`Delete "${task.title}"? This can't be undone.`)) return

    try {
      await window.api.deleteTask(projectId, task.id)
      setProjectHistory((prev) => prev.filter((t) => t.id !== task.id))
    } catch (e) {
      console.error('Failed to delete task', e)
    }
  }

  const handleCloseTaskDetail = async () => {
    setViewingTask(null)
    try {
      const data = await window.api.loadProjectData(projectId)
      if (data && data.tasks) setProjectHistory(data.tasks)
    } catch (e) {
      console.error('Failed to refresh history', e)
    }
  }

  if (viewingTask) {
    return (
      <TaskDetail
        task={viewingTask}
        projectId={projectId}
        onBack={handleCloseTaskDetail}
        onStartFocus={() => onStartFocus(viewingTask.id)}
      />
    )
  }

  if (phase === 'complete' && finalTask) {
    return (
      <TaskDetail
        task={finalTask}
        projectId={projectId}
        onBack={handleNewTask}
        onStartFocus={() => onStartFocus(finalTask.id)}
      />
    )
  }

  return (
    <div className="flex h-full flex-col">
      {/* TOP NAV */}
      <header className="flex shrink-0 items-center gap-3 border-b border-border px-6 py-3.5">
        <button onClick={onBack} className="text-sm text-fg-2 transition hover:text-fg-1">
          ← Dashboard
        </button>
        <span className="text-fg-3">/</span>
        <span className="text-sm font-medium">{projectId.replace(/_/g, ' ')}</span>
        <button
          onClick={() => setShowContext((v) => !v)}
          className="ml-auto rounded-md border border-border px-3 py-1.5 text-xs text-fg-2 transition hover:border-border-strong hover:text-fg-1"
        >
          {showContext ? 'Hide Project Context' : 'View Project Context'}
        </button>
      </header>

      <div className="flex flex-1 justify-center overflow-y-auto">
      <div className="flex min-h-full w-full max-w-3xl flex-col gap-5 px-6 py-6">
        {showContext && <ContextLedgerPanel projectId={projectId} />}

        <h1 className="shrink-0 text-center text-3xl font-semibold tracking-tight">Flow State</h1>

        {/* SCHEDULING CONTROLS */}
        <div className="shrink-0 rounded-2xl glass p-4">
          <div className="grid grid-cols-3 gap-3">
            <label className="flex flex-col gap-1.5">
              <span className="text-xs text-fg-2">Deadline</span>
              <input
                type="date"
                value={deadline}
                onChange={(e) => setDeadline(e.target.value)}
                className="rounded-md border border-border bg-bg-3 px-3 py-2 text-sm text-fg-1 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/40"
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-xs text-fg-2">Depth</span>
              <select
                value={depth}
                onChange={(e) => setDepth(e.target.value)}
                className="rounded-md border border-border bg-bg-3 px-3 py-2 text-sm text-fg-1 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/40"
              >
                <option value="Brief">Brief (Milestones)</option>
                <option value="Deep">Deep (Micro-steps)</option>
              </select>
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-xs text-fg-2">Model</span>
              <ModelSelect value={selectedModel} onChange={handleModelChange} />
            </label>
          </div>
        </div>

        {errorMessage && (
          <div className="shrink-0 rounded-md border-l-4 border-hard bg-hard/10 px-4 py-3 text-sm text-hard">
            {errorMessage}
          </div>
        )}

        {/* CHAT STREAM */}
        <ChatThread messages={messages} loading={loading} streamingText={streamingText} />

        {/* INPUT BAR */}
        <div className="shrink-0 pb-4 pt-2">
          {attachedFileName && (
            <div className="mb-2 inline-flex items-center gap-1.5 rounded-md bg-accent-soft px-3 py-1 text-xs text-accent">
              📎 {attachedFileName}
            </div>
          )}
          <div className="flex items-center gap-2 rounded-2xl glass p-2">
            <button
              onClick={handleAttach}
              disabled={attaching || loading}
              title="Attach a document for context"
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-border text-fg-1 transition hover:border-accent disabled:opacity-50"
            >
              {attaching ? '…' : '📎'}
            </button>
            <input
              type="text"
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleSend()
              }}
              placeholder={messages.length === 0 ? 'e.g. Write 2000 word essay on History' : 'Reply…'}
              disabled={loading}
              className="flex-1 bg-transparent px-2 text-sm text-fg-1 placeholder:text-fg-3 focus:outline-none"
            />
            <button
              onClick={handleSend}
              disabled={loading || !inputText.trim()}
              className="rounded-md bg-accent px-5 py-2.5 text-sm font-medium text-white transition hover:bg-accent-hover disabled:opacity-50"
            >
              Send
            </button>
          </div>
        </div>

        {/* SAVED HISTORY */}
        <SavedTaskList tasks={projectHistory} onView={handleViewTask} onDelete={handleDeleteTask} />
      </div>
      </div>
    </div>
  )
}
