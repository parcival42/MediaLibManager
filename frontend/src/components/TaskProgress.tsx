import { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../api/client'
import { Spinner } from './ui'

export interface Task<R = unknown> {
  status: string
  progress: number
  result?: R
  log?: string
}

/** Poll a task until it reaches a terminal state, then fire `onDone` once with
 * its final data (so the caller can act on `result` without a stale closure
 * over the hook's own return value). */
export function useTaskPolling<R = unknown>(taskId: string | null, onDone: (data: Task<R> | undefined) => void) {
  const task = useQuery<Task<R>>({
    queryKey: ['task', taskId],
    queryFn: () => api<Task<R>>(`/api/tasks/${taskId}`),
    enabled: !!taskId,
    refetchInterval: (query) => {
      if (query.state.error) return false
      const s = query.state.data?.status
      return s && s !== 'running' && s !== 'queued' ? false : 800
    },
  })
  useEffect(() => {
    const s = task.data?.status
    if (s && s !== 'running' && s !== 'queued') onDone(task.data)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.data?.status])
  return task
}

/** Centered progress bar with the task's latest log line as the "what is it doing" caption. */
export function TaskProgressPanel({ percent, activity }: { percent: number; activity: string }) {
  return (
    <div className="w-full max-w-sm text-center">
      <Spinner className="mx-auto mb-4" />
      <div className="mb-2 min-h-[1.25rem] text-sm text-ink-2">{activity}</div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-bg/70">
        <div
          className="h-full rounded-full bg-accent transition-all"
          style={{ width: `${percent}%` }}
        />
      </div>
      <div className="mt-1.5 text-xs font-semibold tabular-nums text-ink-3">{Math.round(percent)}%</div>
    </div>
  )
}
