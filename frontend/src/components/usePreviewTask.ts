import { useCallback, useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../api/client'
import { useI18n } from '../i18n'
import { useTaskPolling } from './TaskProgress'

const cancelTask = (taskId: string) => {
  api(`/api/tasks/${taskId}/cancel`, { method: 'POST' }).catch(() => {})
}

/** React Query key of a preview task's full result (shared by rule and quick previews). */
export const previewResultKey = (taskId: string | null) => ['rename-preview-result', taskId]

/** Orchestrates a rename preview task: start, poll, fetch the cached result.
 *
 * - Every started task is tracked, including responses that arrive after a
 *   newer start or after unmount; those are cancelled instead of being left
 *   running (they would block the serial queue and pause enrichment).
 * - Starting a new preview cancels the previous one (a no-op if it already
 *   finished).
 * - `onNewTask` fires whenever the shown task id changes -- also when the
 *   server hands back an already finished, cached task -- so callers can
 *   reset selections that belong to the previous list. */
export function usePreviewTask<R>({ onNewTask }: { onNewTask?: () => void } = {}) {
  const { t } = useI18n()
  const [taskId, setTaskId] = useState<string | null>(null)
  const taskIdRef = useRef<string | null>(null)
  const seq = useRef(0)
  const [starting, setStarting] = useState(false)
  const [startError, setStartError] = useState<Error | null>(null)
  const onNewTaskRef = useRef(onNewTask)
  onNewTaskRef.current = onNewTask

  useEffect(() => {
    return () => {
      seq.current++ // responses still in flight now count as superseded
      if (taskIdRef.current) cancelTask(taskIdRef.current)
    }
  }, [])

  useEffect(() => {
    if (taskId) onNewTaskRef.current?.()
  }, [taskId])

  /** `onStarted` runs only if this start wins (not superseded, not failed). */
  const start = useCallback((request: () => Promise<{ task_id: string }>, onStarted?: () => void) => {
    const my = ++seq.current
    if (taskIdRef.current) cancelTask(taskIdRef.current)
    setStarting(true)
    setStartError(null)
    request()
      .then((d) => {
        if (my !== seq.current) {
          if (d.task_id !== taskIdRef.current) cancelTask(d.task_id)
          return
        }
        taskIdRef.current = d.task_id
        setTaskId(d.task_id)
        onStarted?.()
      })
      .catch((e: unknown) => {
        if (my === seq.current) setStartError(e as Error)
      })
      .finally(() => {
        if (my === seq.current) setStarting(false)
      })
  }, [])

  const task = useTaskPolling(taskId, () => {})
  const status = task.data?.status
  const result = useQuery<R>({
    queryKey: previewResultKey(taskId),
    queryFn: () => api<R>(`/api/rename/preview/${taskId}`),
    enabled: !!taskId && status === 'done',
    // The payload for a given task id never changes on the server, and the
    // rule page patches this cache entry locally after an apply -- a
    // background refetch would overwrite that patch.
    staleTime: Infinity,
  })

  const busy =
    starting ||
    (!!taskId && status === undefined && !task.isError) ||
    status === 'queued' ||
    status === 'running' ||
    (status === 'done' && result.isLoading)
  const failed =
    !!startError ||
    task.isError ||
    status === 'error' ||
    status === 'cancelled' ||
    status === 'interrupted' ||
    result.isError
  const activity =
    status === 'queued' ? t('ren_preview_queued') : task.data?.log?.trim().split('\n').pop() || t('ren_previewing')

  return { taskId, start, result, busy, failed, startError, activity, percent: task.data?.progress ?? 0 }
}
