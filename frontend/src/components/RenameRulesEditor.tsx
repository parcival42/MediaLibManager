/**
 * Rule/segment builder + directory assignment list for the Rename feature.
 * Embedded on the Settings page: rules and
 * assignments are configuration, edited here; the Rename page itself is only
 * preview + apply.
 */
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../api/client'
import { useI18n } from '../i18n'
import { Button, Card, Input } from './ui'
import { IconChevron, IconFolder } from './icons'
import DirectoryTree from './DirectoryTree'

type SegmentSource = 'literal' | 'dirname' | 'resolution' | 'duration' | 'filename'

interface Segment {
  source: SegmentSource
  text?: string
  level?: number
  transforms?: string[]
}

interface Rule {
  id: number
  name: string
  segments: Segment[]
  separator: string
}

interface Assignment {
  id: number
  directory: string
  rule_id: number
  rule_name: string
}

const SOURCES: SegmentSource[] = ['dirname', 'resolution', 'duration', 'filename', 'literal']

function emptySegment(source: SegmentSource): Segment {
  if (source === 'literal') return { source, text: '' }
  if (source === 'dirname') return { source, level: 1 }
  if (source === 'filename') return { source, transforms: ['strip_scene_tags', 'clean_special_chars'] }
  return { source }
}

function emptyRule(): Rule {
  return { id: 0, name: '', separator: ' - ', segments: [emptySegment('dirname')] }
}

function segmentPreview(seg: Segment, t: (k: string) => string): string {
  switch (seg.source) {
    case 'literal':
      return seg.text || t('ren_segment_text')
    case 'dirname':
      return `${t('ren_segment_dirname')} (${t('ren_segment_level')} ${seg.level ?? 1})`
    default:
      return t(`ren_segment_${seg.source}`)
  }
}

function SegmentEditor({
  segment,
  onChange,
  onRemove,
  onMove,
  canMoveUp,
  canMoveDown,
}: {
  segment: Segment
  onChange: (s: Segment) => void
  onRemove: () => void
  onMove: (dir: -1 | 1) => void
  canMoveUp: boolean
  canMoveDown: boolean
}) {
  const { t } = useI18n()
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-bg/40 p-2.5">
      <select
        value={segment.source}
        onChange={(e) => onChange(emptySegment(e.target.value as SegmentSource))}
        className="h-8 rounded-lg border border-line bg-surface-3 px-2 text-xs text-ink-1 outline-none"
      >
        {SOURCES.map((s) => (
          <option key={s} value={s}>
            {t(`ren_segment_${s}`)}
          </option>
        ))}
      </select>

      {segment.source === 'literal' && (
        <Input
          value={segment.text ?? ''}
          onChange={(e) => onChange({ ...segment, text: e.target.value })}
          placeholder={t('ren_segment_text')}
          className="h-8 w-40 text-xs"
        />
      )}

      {segment.source === 'dirname' && (
        <label className="flex items-center gap-1.5 text-xs text-ink-3">
          {t('ren_segment_level')}
          <input
            type="number"
            min={1}
            value={segment.level ?? 1}
            onChange={(e) => onChange({ ...segment, level: Math.max(1, Number(e.target.value)) })}
            className="h-8 w-16 rounded-lg border border-line bg-surface-3 px-2 text-xs text-ink-1 outline-none"
          />
        </label>
      )}

      {segment.source === 'filename' && (
        <div className="flex items-center gap-3 text-xs text-ink-3">
          <label className="flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={(segment.transforms ?? []).includes('strip_scene_tags')}
              onChange={(e) => {
                const set = new Set(segment.transforms ?? [])
                e.target.checked ? set.add('strip_scene_tags') : set.delete('strip_scene_tags')
                onChange({ ...segment, transforms: [...set] })
              }}
            />
            {t('ren_segment_strip_scene_tags')}
          </label>
          <label className="flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={(segment.transforms ?? []).includes('clean_special_chars')}
              onChange={(e) => {
                const set = new Set(segment.transforms ?? [])
                e.target.checked ? set.add('clean_special_chars') : set.delete('clean_special_chars')
                onChange({ ...segment, transforms: [...set] })
              }}
            />
            {t('ren_segment_clean_special_chars')}
          </label>
        </div>
      )}

      <div className="ml-auto flex items-center gap-1">
        <button
          onClick={() => onMove(-1)}
          disabled={!canMoveUp}
          title={t('ren_segment_up')}
          className="flex h-7 w-7 items-center justify-center rounded-lg text-ink-3 hover:bg-white/5 hover:text-ink-1 disabled:opacity-30"
        >
          <IconChevron className="rotate-180" />
        </button>
        <button
          onClick={() => onMove(1)}
          disabled={!canMoveDown}
          title={t('ren_segment_down')}
          className="flex h-7 w-7 items-center justify-center rounded-lg text-ink-3 hover:bg-white/5 hover:text-ink-1 disabled:opacity-30"
        >
          <IconChevron />
        </button>
        <Button size="sm" variant="ghost" onClick={onRemove}>
          {t('ren_segment_remove')}
        </Button>
      </div>
    </div>
  )
}

function RuleForm({ rule, onSave, onCancel }: { rule: Rule; onSave: (r: Rule) => void; onCancel: () => void }) {
  const { t } = useI18n()
  const [draft, setDraft] = useState<Rule>(rule)

  const updateSegment = (i: number, seg: Segment) =>
    setDraft((d) => ({ ...d, segments: d.segments.map((s, idx) => (idx === i ? seg : s)) }))
  const removeSegment = (i: number) =>
    setDraft((d) => ({ ...d, segments: d.segments.filter((_, idx) => idx !== i) }))
  const moveSegment = (i: number, dir: -1 | 1) =>
    setDraft((d) => {
      const segments = [...d.segments]
      const j = i + dir
      ;[segments[i], segments[j]] = [segments[j], segments[i]]
      return { ...d, segments }
    })
  const addSegment = () => setDraft((d) => ({ ...d, segments: [...d.segments, emptySegment('literal')] }))

  return (
    <Card className="space-y-3 p-4">
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-ink-2">{t('ren_rule_name')}</span>
          <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} className="w-56" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-ink-2">{t('ren_rule_separator')}</span>
          <Input
            value={draft.separator}
            onChange={(e) => setDraft({ ...draft, separator: e.target.value })}
            className="w-24"
          />
        </label>
      </div>

      <div className="space-y-2">
        {draft.segments.map((seg, i) => (
          <SegmentEditor
            key={i}
            segment={seg}
            onChange={(s) => updateSegment(i, s)}
            onRemove={() => removeSegment(i)}
            onMove={(dir) => moveSegment(i, dir)}
            canMoveUp={i > 0}
            canMoveDown={i < draft.segments.length - 1}
          />
        ))}
      </div>
      <Button size="sm" variant="subtle" onClick={addSegment}>
        {t('ren_segment_add')}
      </Button>

      <div className="flex items-center gap-2 pt-1">
        <Button
          size="sm"
          onClick={() => onSave(draft)}
          disabled={!draft.name.trim() || draft.segments.length === 0}
        >
          {t('save')}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          {t('ren_rule_cancel')}
        </Button>
      </div>
    </Card>
  )
}

export default function RenameRulesEditor() {
  const { t } = useI18n()
  const qc = useQueryClient()
  const [editing, setEditing] = useState<Rule | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [newAssignmentDir, setNewAssignmentDir] = useState<string | null>(null)
  const [newAssignmentRule, setNewAssignmentRule] = useState<number | null>(null)

  const rules = useQuery<Rule[]>({ queryKey: ['rename-rules'], queryFn: () => api('/api/rename/rules') })
  const assignments = useQuery<Assignment[]>({
    queryKey: ['rename-assignments'],
    queryFn: () => api('/api/rename/assignments'),
  })

  const saveRule = useMutation({
    mutationFn: (r: Rule) =>
      r.id
        ? api(`/api/rename/rules/${r.id}`, {
            method: 'PUT',
            body: JSON.stringify({ name: r.name, segments: r.segments, separator: r.separator }),
          })
        : api('/api/rename/rules', {
            method: 'POST',
            body: JSON.stringify({ name: r.name, segments: r.segments, separator: r.separator }),
          }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['rename-rules'] })
      setEditing(null)
    },
  })

  const deleteRule = useMutation({
    mutationFn: (id: number) => api(`/api/rename/rules/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['rename-rules'] })
      qc.invalidateQueries({ queryKey: ['rename-assignments'] })
    },
  })

  const addAssignment = useMutation({
    mutationFn: (a: { directory: string; rule_id: number }) =>
      api('/api/rename/assignments', { method: 'POST', body: JSON.stringify(a) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['rename-assignments'] })
      setNewAssignmentDir(null)
      setNewAssignmentRule(null)
    },
  })

  const deleteAssignment = useMutation({
    mutationFn: (id: number) => api(`/api/rename/assignments/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['rename-assignments'] }),
  })

  return (
    <div className="space-y-6">
      <div>
        <h2 className="mb-1 text-lg font-semibold text-ink-1">{t('ren_rules_title')}</h2>
        <p className="mb-3 text-sm text-ink-3">{t('ren_rules_subtitle')}</p>

        <div className="space-y-3">
          {(rules.data ?? []).map((r) =>
            editing?.id === r.id ? (
              <RuleForm key={r.id} rule={editing} onSave={(d) => saveRule.mutate(d)} onCancel={() => setEditing(null)} />
            ) : (
              <Card key={r.id} className="flex flex-wrap items-center gap-3 p-3.5">
                <div className="min-w-0 flex-1">
                  <div className="font-medium text-ink-1">{r.name}</div>
                  <div className="mt-0.5 truncate text-xs text-ink-3">
                    {r.segments.map((s) => segmentPreview(s, t)).join(` "${r.separator}" `)}
                  </div>
                </div>
                <Button size="sm" variant="subtle" onClick={() => setEditing(r)}>
                  {t('ren_rule_edit')}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    if (window.confirm(t('ren_rule_delete_confirm'))) deleteRule.mutate(r.id)
                  }}
                >
                  {t('ren_rule_delete')}
                </Button>
              </Card>
            ),
          )}
          {rules.data?.length === 0 && <p className="text-sm text-ink-3">{t('ren_rules_none')}</p>}
        </div>

        {editing?.id === 0 ? (
          <div className="mt-3">
            <RuleForm rule={editing} onSave={(d) => saveRule.mutate(d)} onCancel={() => setEditing(null)} />
          </div>
        ) : (
          <Button size="sm" variant="subtle" className="mt-3" onClick={() => setEditing(emptyRule())}>
            {t('ren_rule_new')}
          </Button>
        )}
      </div>

      <div>
        <h2 className="mb-1 text-lg font-semibold text-ink-1">{t('ren_assignments_title')}</h2>
        <p className="mb-3 text-sm text-ink-3">{t('ren_assignments_subtitle')}</p>

        <Card className="flex flex-wrap items-center gap-3 p-3">
          <div className="relative">
            <Button size="sm" variant="subtle" onClick={() => setPickerOpen((o) => !o)}>
              <IconFolder width={15} height={15} />
              {newAssignmentDir ?? t('ren_choose_directory')}
            </Button>
            {pickerOpen && (
              <div className="absolute left-0 top-full z-20 mt-2 max-h-80 w-80 overflow-auto rounded-xl border border-line bg-surface-2 p-2 shadow-card">
                <DirectoryTree
                  value={newAssignmentDir}
                  onSelect={(p) => {
                    setNewAssignmentDir(p)
                    setPickerOpen(false)
                  }}
                />
              </div>
            )}
          </div>
          <select
            value={newAssignmentRule ?? ''}
            onChange={(e) => setNewAssignmentRule(Number(e.target.value) || null)}
            className="h-9 rounded-xl border border-line bg-surface-3 px-3 text-sm text-ink-1 outline-none"
          >
            <option value="">{t('ren_rule_label')}</option>
            {(rules.data ?? []).map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
          <Button
            size="sm"
            disabled={!newAssignmentDir || !newAssignmentRule}
            onClick={() =>
              newAssignmentDir &&
              newAssignmentRule &&
              addAssignment.mutate({ directory: newAssignmentDir, rule_id: newAssignmentRule })
            }
          >
            {t('ren_assignment_add')}
          </Button>
        </Card>

        <div className="mt-3 space-y-2">
          {(assignments.data ?? []).map((a) => (
            <Card key={a.id} className="flex items-center gap-3 p-3">
              <span className="min-w-0 flex-1 truncate font-mono text-xs text-ink-2" title={a.directory}>
                {a.directory}
              </span>
              <span className="shrink-0 rounded-md border border-line bg-bg/60 px-2 py-0.5 text-xs text-ink-2">
                {a.rule_name}
              </span>
              <Button size="sm" variant="ghost" onClick={() => deleteAssignment.mutate(a.id)}>
                {t('ren_segment_remove')}
              </Button>
            </Card>
          ))}
          {assignments.data?.length === 0 && <p className="text-sm text-ink-3">{t('ren_assignment_none')}</p>}
        </div>
      </div>
    </div>
  )
}
