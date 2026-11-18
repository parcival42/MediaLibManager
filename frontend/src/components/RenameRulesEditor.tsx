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
import { Badge, Button, Card, Checkbox, Field, Input, SectionTitle, Select, Textarea } from './ui'
import { IconChevron } from './icons'
import ScopePicker from './ScopePicker'

type SegmentSource = 'literal' | 'dirname' | 'resolution' | 'duration' | 'filename'

interface Segment {
  source: SegmentSource
  text?: string
  level?: number
  transforms?: string[]
  strip_filter_ids?: number[]
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

interface ReplaceEntry {
  from: string
  to: string
}

interface StripFilter {
  id: number
  name: string
  type: 'strings' | 'replace_chars'
  entries: string[] | ReplaceEntry[]
}

const SOURCES: SegmentSource[] = ['dirname', 'resolution', 'duration', 'filename', 'literal']

function emptySegment(source: SegmentSource): Segment {
  if (source === 'literal') return { source, text: '' }
  if (source === 'dirname') return { source, level: 1 }
  if (source === 'filename') return { source, transforms: [], strip_filter_ids: [] }
  return { source }
}

function emptyRule(): Rule {
  return { id: 0, name: '', separator: ' - ', segments: [emptySegment('dirname')] }
}

function emptyFilter(): StripFilter {
  return { id: 0, name: '', type: 'strings', entries: [] }
}

function emptyReplaceEntry(): ReplaceEntry {
  return { from: '', to: '' }
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

// ---------------------------------------------------------------------------
// Strip filter form
// ---------------------------------------------------------------------------

function StripFilterForm({
  filter,
  onSave,
  onCancel,
}: {
  filter: StripFilter
  onSave: (f: StripFilter) => void
  onCancel: () => void
}) {
  const { t } = useI18n()
  const [draft, setDraft] = useState<StripFilter>(filter)

  const stringEntries = draft.type === 'strings' ? (draft.entries as string[]) : []
  const replaceEntries = draft.type === 'replace_chars' ? (draft.entries as ReplaceEntry[]) : []

  const switchType = (newType: StripFilter['type']) => {
    setDraft({ ...draft, type: newType, entries: newType === 'replace_chars' ? [] : [] })
  }

  const updateReplaceEntry = (i: number, patch: Partial<ReplaceEntry>) => {
    const updated = replaceEntries.map((e, idx) => (idx === i ? { ...e, ...patch } : e))
    setDraft({ ...draft, entries: updated })
  }

  const removeReplaceEntry = (i: number) => {
    setDraft({ ...draft, entries: replaceEntries.filter((_, idx) => idx !== i) })
  }

  return (
    <Card className="space-y-4 p-4">
      <div className="flex flex-wrap items-end gap-3">
        <Field label={t('ren_strip_filter_name')}>
          <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} className="w-56" />
        </Field>
        <Field label={t('ren_strip_filter_type')}>
          <Select value={draft.type} onChange={(e) => switchType(e.target.value as StripFilter['type'])}>
            <option value="strings">{t('ren_strip_filter_type_strings')}</option>
            <option value="replace_chars">{t('ren_strip_filter_type_replace_chars')}</option>
          </Select>
        </Field>
      </div>

      {draft.type === 'strings' && (
        <Field label={t('ren_strip_filter_entries')}>
          <Textarea
            value={stringEntries.join('\n')}
            onChange={(e) => setDraft({ ...draft, entries: e.target.value.split('\n') })}
            rows={6}
          />
        </Field>
      )}

      {draft.type === 'replace_chars' && (
        <div className="space-y-2">
          <span className="block text-xs font-medium text-ink-2">{t('ren_strip_filter_entries')}</span>
          {replaceEntries.map((entry, i) => (
            <div key={i} className="flex items-center gap-2">
              <Input
                value={entry.from}
                onChange={(e) => updateReplaceEntry(i, { from: e.target.value })}
                placeholder={t('ren_strip_filter_replace_from')}
                inputSize="sm" className="w-24 font-mono"
              />
              <span className="text-xs text-ink-3">→</span>
              <Input
                value={entry.to}
                onChange={(e) => updateReplaceEntry(i, { to: e.target.value })}
                placeholder={t('ren_strip_filter_replace_to')}
                inputSize="sm" className="w-24 font-mono"
              />
              <Button size="sm" variant="ghost" onClick={() => removeReplaceEntry(i)}>
                {t('ren_segment_remove')}
              </Button>
            </div>
          ))}
          <Button
            size="sm"
            variant="subtle"
            onClick={() => setDraft({ ...draft, entries: [...replaceEntries, emptyReplaceEntry()] })}
          >
            {t('ren_strip_filter_add_pair')}
          </Button>
        </div>
      )}

      <div className="flex items-center gap-2 pt-1">
        <Button
          size="sm"
          onClick={() => {
            const cleaned =
              draft.type === 'strings'
                ? { ...draft, entries: (draft.entries as string[]).map((s) => s.trim()).filter(Boolean) }
                : draft
            onSave(cleaned)
          }}
          disabled={!draft.name.trim()}
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

// ---------------------------------------------------------------------------
// Segment editor
// ---------------------------------------------------------------------------

function SegmentEditor({
  segment,
  onChange,
  onRemove,
  onMove,
  canMoveUp,
  canMoveDown,
  stripFilters,
}: {
  segment: Segment
  onChange: (s: Segment) => void
  onRemove: () => void
  onMove: (dir: -1 | 1) => void
  canMoveUp: boolean
  canMoveDown: boolean
  stripFilters: StripFilter[]
}) {
  const { t } = useI18n()

  const toggleTransform = (name: string, on: boolean) => {
    const set = new Set(segment.transforms ?? [])
    if (on) set.add(name)
    else set.delete(name)
    onChange({ ...segment, transforms: [...set] })
  }
  const toggleFilter = (id: number, on: boolean) => {
    const set = new Set(segment.strip_filter_ids ?? [])
    if (on) set.add(id)
    else set.delete(id)
    onChange({ ...segment, strip_filter_ids: [...set] })
  }

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-bg/40 p-2.5">
      <Select
        inputSize="sm"
        value={segment.source}
        onChange={(e) => onChange(emptySegment(e.target.value as SegmentSource))}
        aria-label={t('ren_segment_source')}
      >
        {SOURCES.map((s) => (
          <option key={s} value={s}>
            {t(`ren_segment_${s}`)}
          </option>
        ))}
      </Select>

      {segment.source === 'literal' && (
        <Input
          value={segment.text ?? ''}
          onChange={(e) => onChange({ ...segment, text: e.target.value })}
          placeholder={t('ren_segment_text')}
          aria-label={t('ren_segment_text')}
          inputSize="sm"
          className="w-40"
        />
      )}

      {segment.source === 'dirname' && (
        <label className="flex items-center gap-1.5 text-xs text-ink-3">
          {t('ren_segment_level')}
          <Input
            type="number"
            min={1}
            inputSize="sm"
            value={segment.level ?? 1}
            onChange={(e) => onChange({ ...segment, level: Math.max(1, Number(e.target.value)) })}
            className="w-16"
          />
        </label>
      )}

      {segment.source === 'filename' && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <Checkbox
            className="!text-xs"
            checked={(segment.transforms ?? []).includes('clean_special_chars')}
            onChange={(v) => toggleTransform('clean_special_chars', v)}
            label={t('ren_segment_clean_special_chars')}
          />
          <Checkbox
            className="!text-xs"
            checked={(segment.transforms ?? []).includes('strip_resolution')}
            onChange={(v) => toggleTransform('strip_resolution', v)}
            label={t('ren_segment_strip_resolution')}
          />
          {stripFilters.length > 0 && (
            <span className="border-l border-line pl-4 text-xs font-medium text-ink-2">
              {t('ren_segment_strip_filters_label')}:
            </span>
          )}
          {stripFilters.map((f) => (
            <Checkbox
              key={f.id}
              className="!text-xs"
              checked={(segment.strip_filter_ids ?? []).includes(f.id)}
              onChange={(v) => toggleFilter(f.id, v)}
              label={f.name}
            />
          ))}
        </div>
      )}

      <div className="ml-auto flex items-center gap-1">
        <Button
          size="icon"
          variant="ghost"
          onClick={() => onMove(-1)}
          disabled={!canMoveUp}
          title={t('ren_segment_up')}
          aria-label={t('ren_segment_up')}
        >
          <IconChevron className="rotate-180" />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          onClick={() => onMove(1)}
          disabled={!canMoveDown}
          title={t('ren_segment_down')}
          aria-label={t('ren_segment_down')}
        >
          <IconChevron />
        </Button>
        <Button size="sm" variant="ghost" onClick={onRemove}>
          {t('ren_segment_remove')}
        </Button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Rule form
// ---------------------------------------------------------------------------

function RuleForm({
  rule,
  onSave,
  onCancel,
  stripFilters,
}: {
  rule: Rule
  onSave: (r: Rule) => void
  onCancel: () => void
  stripFilters: StripFilter[]
}) {
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
    <Card className="space-y-4 p-4">
      <div className="flex flex-wrap items-end gap-3">
        <Field label={t('ren_rule_name')}>
          <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} className="w-56" />
        </Field>
        <Field label={t('ren_rule_separator')}>
          <Input
            value={draft.separator}
            onChange={(e) => setDraft({ ...draft, separator: e.target.value })}
            className="w-24"
          />
        </Field>
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
            stripFilters={stripFilters}
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

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function RenameRulesEditor() {
  const { t } = useI18n()
  const qc = useQueryClient()
  const [editingRule, setEditingRule] = useState<Rule | null>(null)
  const [editingFilter, setEditingFilter] = useState<StripFilter | null>(null)
  const [newAssignmentDir, setNewAssignmentDir] = useState<string | null>(null)
  const [newAssignmentRule, setNewAssignmentRule] = useState<number | null>(null)

  const stripFiltersQuery = useQuery<StripFilter[]>({
    queryKey: ['strip-filters'],
    queryFn: () => api('/api/rename/strip-filters'),
  })
  const rules = useQuery<Rule[]>({ queryKey: ['rename-rules'], queryFn: () => api('/api/rename/rules') })
  const assignments = useQuery<Assignment[]>({
    queryKey: ['rename-assignments'],
    queryFn: () => api('/api/rename/assignments'),
  })

  const saveFilter = useMutation({
    mutationFn: (f: StripFilter) =>
      f.id
        ? api(`/api/rename/strip-filters/${f.id}`, {
            method: 'PUT',
            body: JSON.stringify({ name: f.name, type: f.type, entries: f.entries }),
          })
        : api('/api/rename/strip-filters', {
            method: 'POST',
            body: JSON.stringify({ name: f.name, type: f.type, entries: f.entries }),
          }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['strip-filters'] })
      setEditingFilter(null)
    },
  })

  const deleteFilter = useMutation({
    mutationFn: (id: number) => api(`/api/rename/strip-filters/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['strip-filters'] }),
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
      setEditingRule(null)
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

  const stripFilters = stripFiltersQuery.data ?? []

  return (
    <div className="space-y-8">
      {/* ------------------------------------------------------------------ */}
      {/* Strip filters                                                        */}
      {/* ------------------------------------------------------------------ */}
      <div>
        <SectionTitle title={t('ren_strip_filters_title')} description={t('ren_strip_filters_subtitle')} />

        <div className="space-y-3">
          {stripFilters.map((f) =>
            editingFilter?.id === f.id ? (
              <StripFilterForm
                key={f.id}
                filter={editingFilter}
                onSave={(d) => saveFilter.mutate(d)}
                onCancel={() => setEditingFilter(null)}
              />
            ) : (
              <Card key={f.id} className="flex flex-wrap items-center gap-3 p-3.5">
                <div className="min-w-0 flex-1">
                  <div className="font-medium text-ink-1">{f.name}</div>
                  <div className="mt-0.5 text-xs text-ink-3">
                    {t(`ren_strip_filter_type_${f.type}`)} &middot; {f.entries.length}{' '}
                    {f.entries.length === 1 ? t('ren_strip_filter_entry') : t('ren_strip_filter_entries_count')}
                  </div>
                </div>
                <Button size="sm" variant="subtle" onClick={() => setEditingFilter(f)}>
                  {t('ren_strip_filter_edit')}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    if (window.confirm(t('ren_strip_filter_delete_confirm'))) deleteFilter.mutate(f.id)
                  }}
                >
                  {t('ren_strip_filter_delete')}
                </Button>
              </Card>
            ),
          )}
          {stripFilters.length === 0 && !editingFilter && (
            <p className="text-sm text-ink-3">{t('ren_strip_filter_none')}</p>
          )}
        </div>

        {editingFilter?.id === 0 ? (
          <div className="mt-3">
            <StripFilterForm
              filter={editingFilter}
              onSave={(d) => saveFilter.mutate(d)}
              onCancel={() => setEditingFilter(null)}
            />
          </div>
        ) : (
          <Button size="sm" variant="subtle" className="mt-3" onClick={() => setEditingFilter(emptyFilter())}>
            {t('ren_strip_filter_new')}
          </Button>
        )}
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Rename rules                                                         */}
      {/* ------------------------------------------------------------------ */}
      <div>
        <SectionTitle title={t('ren_rules_title')} description={t('ren_rules_subtitle')} />

        <div className="space-y-3">
          {(rules.data ?? []).map((r) =>
            editingRule?.id === r.id ? (
              <RuleForm
                key={r.id}
                rule={editingRule}
                onSave={(d) => saveRule.mutate(d)}
                onCancel={() => setEditingRule(null)}
                stripFilters={stripFilters}
              />
            ) : (
              <Card key={r.id} className="flex flex-wrap items-center gap-3 p-3.5">
                <div className="min-w-0 flex-1">
                  <div className="font-medium text-ink-1">{r.name}</div>
                  <div className="mt-0.5 truncate text-xs text-ink-3">
                    {r.segments.map((s) => segmentPreview(s, t)).join(` "${r.separator}" `)}
                  </div>
                </div>
                <Button size="sm" variant="subtle" onClick={() => setEditingRule(r)}>
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

        {editingRule?.id === 0 ? (
          <div className="mt-3">
            <RuleForm
              rule={editingRule}
              onSave={(d) => saveRule.mutate(d)}
              onCancel={() => setEditingRule(null)}
              stripFilters={stripFilters}
            />
          </div>
        ) : (
          <Button size="sm" variant="subtle" className="mt-3" onClick={() => setEditingRule(emptyRule())}>
            {t('ren_rule_new')}
          </Button>
        )}
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Directory assignments                                                */}
      {/* ------------------------------------------------------------------ */}
      <div>
        <SectionTitle title={t('ren_assignments_title')} description={t('ren_assignments_subtitle')} />

        <Card className="flex flex-wrap items-center gap-3 p-3">
          <ScopePicker
            value={newAssignmentDir}
            onChange={setNewAssignmentDir}
            emptyLabel={t('ren_choose_directory')}
          />
          <Select
            inputSize="sm"
            value={newAssignmentRule ?? ''}
            onChange={(e) => setNewAssignmentRule(Number(e.target.value) || null)}
            aria-label={t('ren_rule_label')}
          >
            <option value="">{t('ren_rule_label')}</option>
            {(rules.data ?? []).map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </Select>
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
              <Badge tone="neutral">{a.rule_name}</Badge>
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
