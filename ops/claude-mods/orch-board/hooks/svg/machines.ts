import type { Board } from '../../types'
import { MACHINE_CUTS, machinePresentation, meterTone } from '../sections/meters-format'
import { INSET, Layout, chip, columnWidth, gauge, rows, text, thresholdTone, wrap, type Image } from './kinora'

// Pult row (decision 17558): host pill and title, activity, then the aligned gauge table.
export function machinesSvg(data: Board, width: number, now: number): Image {
  if (!data.machines.length) {
    const l = new Layout(width)
    l.line('no machines', 'muted')
    return l.finish('Machines')
  }
  const cellWidth = columnWidth(width, 360)
  const cells = data.machines.map(machine => {
    const l = new Layout(cellWidth - 2 * INSET, 0)
    l.y = 10
    const view = machinePresentation(machine, data.seats, now)
    const host = chip(0, l.y + 13, machine.name, 'teal', machine.name === 'mac' ? 'this Mac' : 'host of hosts.json', undefined, true, machine.name === 'mac' ? 'host' : 'remote')
    l.body += host.svg + text(host.width + 8, l.y + 13, view.title, 'ink', 13, l.width - host.width - 8, true)
    l.y += 22
    l.line(view.activity, 'muted', 12)
    if (view.loadStatus) l.line(view.loadStatus, view.failed ? 'red' : 'muted', 12)
    l.y += 4
    for (const g of view.gauges) {
      l.body += gauge(0, l.y + 11.5, l.width, g.label, g.percent, g.text, thresholdTone(meterTone(g.percent, MACHINE_CUTS)))
      const stacked = l.width < 254
      l.y += (Math.max(1, wrap(g.text, l.width - (stacked ? 46 : 174), 11.5).length) + (stacked ? 1 : 0)) * 16.675 + 4
    }
    if (view.diskError) l.line(view.diskError, 'red', 12)
    l.y += 8
    l.frame = view.failed
    return l
  })
  return rows(width, cells, cellWidth, 'Machines')
}
