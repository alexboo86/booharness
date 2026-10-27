import type { ClientModule } from 'claude-code'

type LineProps = { line: string }

// The frame clock stops when this instance unmounts, so the pane polls only while it is drawn.
const Poll: ClientModule<LineProps, true> = (props, surface) => {
  if (surface.state === undefined) {
    const tick = () => {
      surface.post(surface.state === undefined ? { tick: true, reset: true } : { tick: true })
}
    surface.every(3_000, tick)
    tick()
    surface.setState(true)
  }
  const { Box, Text } = surface.elements
  if (!props.line) return <Box height={0} />
  return <Text>{props.line}</Text>
}

export default Poll
