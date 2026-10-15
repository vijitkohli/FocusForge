import { useEffect, useRef, useState, type JSX } from 'react'
import { AlertCircle, ArrowLeft, LoaderCircle, Paperclip } from 'lucide-react'
import { DEFAULT_CHAT_MODEL } from 'src/common/models'
import { localDateKey } from 'src/common/schedule'
import {
  cleanTaskTitle,
  withCompletion,
  type ChatMessage,
  type ProjectTask
} from 'src/common/types'
import type { NavigationProps } from '../shell/navigation'
import { Button, DateInput, IconButton, SegmentedControl, Skeleton, Textarea } from '../ui'
import { ChatThread } from '../components/ChatThread'
import { ModelSelect } from '../components/ModelSelect'

export interface CoachProps extends NavigationProps {
  projectId: string
}

export function Coach(props: CoachProps): JSX.Element {
  return <CoachConversation key={props.projectId} {...props} />
}

function CoachConversation({ projectId, onOpenProject }: CoachProps): JSX.Element {
  const [name, setName] = useState(projectId.replace(/_/g, ' '))
  const [selectedModel, setSelectedModel] = useState(DEFAULT_CHAT_MODEL)
  const [deadline, setDeadline] = useState(localDateKey(new Date()))
  const [depth, setDepth] = useState('Brief')
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [inputText, setInputText] = useState('')
  const [initializing, setInitializing] = useState(true)
  const [ready, setReady] = useState(false)
  const [retry, setRetry] = useState(0)
  const [loading, setLoading] = useState(false)
  const [modelSaving, setModelSaving] = useState(false)
  const [streamingText, setStreamingText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [attachedFileName, setAttachedFileName] = useState<string | null>(null)
  const [attaching, setAttaching] = useState(false)
  const [pendingTask, setPendingTask] = useState<ProjectTask | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const busyRef = useRef(false)
  const modelBusyRef = useRef(false)
  const attachBusyRef = useRef(false)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    setInitializing(true)
    setReady(false)
    setError(null)
    void Promise.all([window.api.loadProjectData(projectId), window.api.getSettings()])
      .then(([data, settings]) => {
        if (cancelled) return
        if (!data)
          throw new Error("Couldn't load this project. Return to the library or try again.")
        setName(data.name || projectId.replace(/_/g, ' '))
        setSelectedModel(data.lastModel ?? settings.chatModel ?? DEFAULT_CHAT_MODEL)
        setReady(true)
      })
      .catch((cause: unknown) => {
        if (!cancelled)
          setError(
            cause instanceof Error ? cause.message : "Couldn't load the coach settings. Try again."
          )
      })
      .finally(() => {
        if (!cancelled) setInitializing(false)
      })
    return () => {
      cancelled = true
    }
  }, [projectId, retry])

  useEffect(
    () =>
      window.api.onChatStream((text) => {
        if (mountedRef.current && busyRef.current) setStreamingText((previous) => previous + text)
      }),
    []
  )

  useEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    textarea.style.height = 'auto'
    // A 22px line height plus the field's 16px vertical padding: one to six lines.
    textarea.style.height = `${Math.min(148, Math.max(38, textarea.scrollHeight))}px`
  }, [inputText, initializing])

  useEffect(() => {
    if (ready && !loading && !attaching && !modelSaving) textareaRef.current?.focus()
  }, [ready, loading, attaching, modelSaving])

  const changeModel = async (model: string): Promise<void> => {
    if (!ready || busyRef.current || modelBusyRef.current || attachBusyRef.current || pendingTask)
      return
    const previous = selectedModel
    modelBusyRef.current = true
    setModelSaving(true)
    setSelectedModel(model)
    setError(null)
    try {
      const data = await window.api.loadProjectData(projectId)
      if (!data) throw new Error('Project not found. Return to the library.')
      const result = await window.api.saveProjectData(projectId, { ...data, lastModel: model })
      if (!result.success)
        throw new Error(result.error || "Couldn't remember this model. Select it again to retry.")
    } catch (cause) {
      if (mountedRef.current) {
        setSelectedModel(previous)
        setError(
          cause instanceof Error
            ? cause.message
            : "Couldn't remember this model. Select it again to retry."
        )
      }
    } finally {
      modelBusyRef.current = false
      if (mountedRef.current) setModelSaving(false)
    }
  }

  const saveTask = async (task: ProjectTask): Promise<void> => {
    const data = await window.api.loadProjectData(projectId)
    if (!data) throw new Error('Project not found. Return to the library.')
    // A save can write the file then fail updating the registry. Retrying the same
    // generated task must replace its ID rather than create a duplicate plan.
    const tasks = data.tasks ?? []
    const result = await window.api.saveProjectData(projectId, {
      ...data,
      lastModel: task.model,
      tasks: tasks.some((item) => item.id === task.id)
        ? tasks.map((item) => (item.id === task.id ? task : item))
        : [...tasks, task]
    })
    if (!result.success)
      throw new Error(result.error || "Couldn't save your plan. Try saving again.")
    if (mountedRef.current) {
      setPendingTask(null)
      onOpenProject(projectId, task.id)
    }
  }

  const send = async (): Promise<void> => {
    if (
      !ready ||
      busyRef.current ||
      modelBusyRef.current ||
      attachBusyRef.current ||
      (!pendingTask && !inputText.trim())
    )
      return
    if (!deadline) {
      setError('Choose a due date before sending.')
      return
    }
    busyRef.current = true
    setLoading(true)
    setError(null)
    setStreamingText('')
    const originalInput = inputText
    const nextMessages: ChatMessage[] = [...messages, { role: 'user', content: originalInput }]
    let generatedTask = pendingTask
    if (!pendingTask) {
      setMessages(nextMessages)
      setInputText('')
    }

    try {
      if (!generatedTask) {
        const response = await window.api.sendChatMessage({
          projectId,
          messages: nextMessages,
          deadline,
          depth,
          model: selectedModel
        })
        if (!mountedRef.current) return
        if (response.status === 'error') {
          setMessages(messages)
          setInputText(originalInput)
          setError(response.message)
          return
        }
        if (response.status === 'clarifying') {
          setMessages([...nextMessages, { role: 'assistant', content: response.message }])
          return
        }
        if (response.status !== 'complete' || !response.data) {
          setMessages(messages)
          setInputText(originalInput)
          setError("The coach didn't return a plan. Send again to retry.")
          return
        }
        const conversation: ChatMessage[] = [
          ...nextMessages,
          { role: 'assistant', content: response.message }
        ]
        generatedTask = {
          id: crypto.randomUUID(),
          title:
            cleanTaskTitle(
              nextMessages.find((message) => message.role === 'user')?.content ?? ''
            ) ||
            cleanTaskTitle(response.data.originalTask) ||
            'Untitled task',
          createdAt: new Date().toISOString(),
          deadline,
          subtasks: (response.data.subtasks ?? []).map((step) => withCompletion(step, false)),
          prerequisites: (response.data.prerequisites ?? []).map((item) =>
            withCompletion(item, false)
          ),
          status: 'in-progress',
          depth,
          model: selectedModel,
          conversation
        }
        setPendingTask(generatedTask)
        setStreamingText('')
      }
      try {
        await saveTask(generatedTask)
      } catch (cause) {
        if (mountedRef.current) {
          setMessages(messages)
          setInputText(originalInput)
          setError(
            `Your plan is ready but wasn't saved. ${cause instanceof Error ? cause.message : 'Try saving again.'}`
          )
        }
      }
    } catch (cause) {
      console.error('Failed to reach the coach', cause)
      if (mountedRef.current) {
        setMessages(messages)
        setInputText(originalInput)
        setError("Couldn't reach the coach. Check that CLIProxyAPI is running, then send again.")
      }
    } finally {
      busyRef.current = false
      if (mountedRef.current) {
        setLoading(false)
        setStreamingText('')
      }
    }
  }

  const attach = async (): Promise<void> => {
    if (!ready || attachBusyRef.current || busyRef.current || modelBusyRef.current || pendingTask)
      return
    attachBusyRef.current = true
    setAttaching(true)
    setError(null)
    try {
      const result = await window.api.selectAndExtractDocument(
        projectId,
        messages.find((message) => message.role === 'user')?.content ||
          inputText.trim() ||
          'task context'
      )
      if (!mountedRef.current) return
      if (result?.error) setError(result.error)
      else if (result) setAttachedFileName(result.fileName)
    } catch (cause) {
      if (mountedRef.current)
        setError(
          cause instanceof Error
            ? cause.message
            : "Couldn't read that document. Try attaching it again."
        )
    } finally {
      attachBusyRef.current = false
      if (mountedRef.current) setAttaching(false)
    }
  }

  const disabled = !ready || loading || attaching || modelSaving

  return (
    <div className="mx-auto flex h-full min-h-0 w-full max-w-[784px] flex-col px-8">
      <header className="flex shrink-0 items-center gap-3 border-b border-line py-4">
        <Button
          variant="ghost"
          size="sm"
          leadingIcon={ArrowLeft}
          onClick={() => onOpenProject(projectId)}
        >
          {name}
        </Button>
        <h1 className="text-lg font-bold tracking-[-0.01em]">New task with coach</h1>
      </header>
      {initializing ? (
        <div role="status" aria-label="Loading coach" className="min-h-0 flex-1 space-y-4 py-6">
          <Skeleton className="h-20 w-4/5" />
          <Skeleton className="h-8 w-3/5" />
        </div>
      ) : (
        <ChatThread
          messages={messages}
          loading={loading && !pendingTask}
          streamingText={streamingText}
          onExampleSelect={
            ready && !pendingTask
              ? (text) => {
                  setInputText(text)
                  textareaRef.current?.focus()
                }
              : undefined
          }
        />
      )}
      <div className="shrink-0 border-t border-line bg-bg-1 pt-3 pb-4">
        {error && (
          <div role="alert" className="mb-3 flex items-start gap-2 rounded-md bg-bg-2 p-3 text-sm">
            <AlertCircle
              size={18}
              strokeWidth={1.75}
              aria-hidden="true"
              className="shrink-0 text-hard"
            />
            <div className="min-w-0">
              <p>{error}</p>
              {!ready && !initializing && (
                <Button variant="ghost" size="sm" onClick={() => setRetry((value) => value + 1)}>
                  Retry loading
                </Button>
              )}
            </div>
          </div>
        )}
        {pendingTask && !loading && (
          <div className="mb-3 flex flex-wrap items-center gap-2 text-sm text-fg-2">
            <p>Retry saving without generating another plan.</p>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setPendingTask(null)
                setError(null)
              }}
            >
              Keep chatting instead
            </Button>
          </div>
        )}
        {attachedFileName && (
          <div className="mb-3 inline-flex max-w-full items-center gap-2 rounded-sm bg-bg-2 px-3 py-1.5 text-[12.5px] text-fg-2">
            <Paperclip size={16} strokeWidth={1.75} aria-hidden="true" />
            <span className="truncate">{attachedFileName}</span>
          </div>
        )}
        <div className="mb-3 flex flex-wrap items-end gap-3">
          <div className="w-[170px] shrink-0">
            <DateInput
              label="Due"
              pickerLabel="Open calendar for due date"
              value={deadline}
              onChange={(event) => setDeadline(event.target.value)}
              disabled={disabled || !!pendingTask}
              required
            />
          </div>
          <div className="space-y-1.5">
            <p className="text-[12.5px] font-medium text-fg-2">Detail</p>
            <SegmentedControl
              label="Plan detail"
              options={[
                { value: 'Brief', label: 'Brief' },
                { value: 'Deep', label: 'Deep' }
              ]}
              value={depth}
              onChange={setDepth}
              disabled={disabled || !!pendingTask}
            />
          </div>
          <div className="min-w-[160px] flex-1">
            <ModelSelect
              label="Model"
              value={selectedModel}
              onChange={(model) => void changeModel(model)}
              disabled={disabled || !!pendingTask}
            />
          </div>
        </div>
        <form
          className="flex items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            void send()
          }}
        >
          <IconButton
            label="Attach a PDF to this project's notes"
            size={36}
            disabled={disabled || !!pendingTask}
            onClick={() => void attach()}
          >
            {attaching ? (
              <LoaderCircle
                size={18}
                strokeWidth={1.75}
                className="animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
            ) : (
              <Paperclip size={18} strokeWidth={1.75} aria-hidden="true" />
            )}
          </IconButton>
          <div className="min-w-0 flex-1">
            <Textarea
              ref={textareaRef}
              aria-label="Message to the coach"
              rows={1}
              value={inputText}
              onChange={(event) => setInputText(event.target.value)}
              placeholder={
                messages.length === 0 ? 'Tell me what you need to do' : 'Reply to the coach'
              }
              disabled={disabled}
              readOnly={!!pendingTask}
              className="min-h-0 resize-none leading-[22px]"
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault()
                  void send()
                }
              }}
            />
          </div>
          <Button
            type="submit"
            variant="primary"
            loading={loading}
            loadingLabel={pendingTask ? 'Saving plan' : 'Sending message'}
            disabled={disabled || (!pendingTask && !inputText.trim())}
          >
            {pendingTask ? 'Save plan' : 'Send'}
          </Button>
        </form>
      </div>
    </div>
  )
}
