import type { ClientModule } from 'claude-code'

/**
 * What the hooks module hands the band's `Client`: the row already laid out,
 * each tooltip's text and where it starts. This module only draws it and
 * follows the pointer, so a tooltip never stands between the pointer and the
 * square under it: it reads the column, not what is drawn there.
 */
export type BandClientProps = {
  columns: number
  /** Width of the right-hand area: the label, then the button. */
  labelWidth: number
  /** The squares, run by run: neighbours drawn alike share one text. */
  runs: { text: string; color: string; dim: boolean }[]
  /** One per square, in order: its tooltip (an index into `tips`) and where that starts. */
  squares: { tip: number; x: number }[]
  tips: { text: string; color: string }[]
  label: { text: string; color: string; inverse: boolean; tip: number; x: number }
  /** The refresh button; null while there is no warm cache to keep. */
  button: { text: string; tip: number; x: number } | null
}

/** What the pointer is over: a square by index, the label, the button, or nothing. */
type Hover = { kind: 'square'; index: number } | { kind: 'label' } | { kind: 'button' } | null

type State = { hover: Hover }

function hoverAt(x: number, props: BandClientProps): Hover {
  if (x < 0 || x >= props.columns) return null
  const index = Math.floor(x / 2)
  if (index < props.squares.length) return { kind: 'square', index }
  const buttonWidth = props.button === null ? 0 : props.button.text.length
  if (props.button !== null && x >= props.columns - buttonWidth) return { kind: 'button' }
  const labelEnd = props.columns - buttonWidth - (props.button === null ? 0 : 1)
  if (x >= labelEnd - props.label.text.length && x < labelEnd) return { kind: 'label' }
  return null
}

function sameHover(a: Hover, b: Hover): boolean {
  if (a === null || b === null) return a === b
  if (a.kind === 'square' && b.kind === 'square') return a.index === b.index
  return a.kind === b.kind
}

const Band: ClientModule<BandClientProps, State> = (props, surface) => {
  const { Box, Button, Text } = surface.elements
  const hover = surface.state?.hover ?? null

  // Re-set on every draw so the listener reads this draw's props; one listener per instance.
  surface.onPointer(event => {
    const next = event.type === 'leave' ? null : hoverAt(event.x, props)
    if (!sameHover(next, hover)) surface.setState({ hover: next })
  })

  const tipFor = (): { text: string; color: string; x: number } | null => {
    if (hover === null) return null
    if (hover.kind === 'square') {
      const square = props.squares[hover.index]
      const tip = square === undefined ? undefined : props.tips[square.tip]
      return square === undefined || tip === undefined ? null : { ...tip, x: square.x }
    }
    const owner = hover.kind === 'label' ? props.label : props.button
    const tip = owner === null ? undefined : props.tips[owner.tip]
    return owner === null || tip === undefined ? null : { ...tip, x: owner.x }
  }
  const tip = tipFor()

  return (
    <Box flexDirection="row" justifyContent="space-between" width={props.columns}>
      <Box flexDirection="row">
        {props.runs.map((run, i) =>
          run.dim ? (
            <Text key={`run-${i}`} dimColor>
              {run.text}
            </Text>
          ) : (
            <Text key={`run-${i}`} color={run.color}>
              {run.text}
            </Text>
          ),
        )}
      </Box>
      <Box flexDirection="row" justifyContent="flex-end" gap={1} width={props.labelWidth}>
        <Text color={props.label.color} inverse={props.label.inverse}>
          {props.label.text}
        </Text>
        {props.button === null ? null : (
          <Button key="refresh" label={props.button.text} plain dimColor onPress={() => surface.post({ refresh: true })} />
        )}
      </Box>
      {tip === null ? null : (
        <Box key="tip" position="absolute" top={0} left={tip.x}>
          <Text color={tip.color} inverse>
            {tip.text}
          </Text>
        </Box>
      )}
    </Box>
  )
}

export default Band
